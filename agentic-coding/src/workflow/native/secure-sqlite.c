/* Repository-owned SQLite VFS. Uses only public SQLite extension/VFS APIs.
 * SQLite owns transactions and rollback recovery; this layer confines ALL main
 * and sidecar filesystem operations to held directory/file capabilities.
 * WAL is supported only with exclusive locking (heap WAL index), for conversion
 * of legacy stores. Normal operation uses durable rollback journals. */
#define _GNU_SOURCE
/* Apple's public sqlite3.h describes its system library as omitting extension
 * loading. We target the host-provided extension API, not that system library.
 * Include the public types first, then select the standard extension macros. */
#include <sqlite3.h>
#undef SQLITE_OMIT_LOAD_EXTENSION
#undef SQLITE_CORE
#include <sqlite3ext.h>
/* Use the supplied public API table explicitly, never link a second SQLite
 * library into Bun. Some platform SDKs disable the convenience macros. */
static const sqlite3_api_routines *sqlite_api;
#undef sqlite3_malloc
#undef sqlite3_free
#undef sqlite3_mutex_alloc
#undef sqlite3_mutex_enter
#undef sqlite3_mutex_leave
#undef sqlite3_result_error
#undef sqlite3_result_error_nomem
#undef sqlite3_result_int
#undef sqlite3_value_int
#undef sqlite3_value_text
#undef sqlite3_vfs_find
#undef sqlite3_vfs_register
#undef sqlite3_create_function_v2
#define sqlite3_malloc sqlite_api->malloc
#define sqlite3_free sqlite_api->free
#define sqlite3_mutex_alloc sqlite_api->mutex_alloc
#define sqlite3_mutex_enter sqlite_api->mutex_enter
#define sqlite3_mutex_leave sqlite_api->mutex_leave
#define sqlite3_result_error sqlite_api->result_error
#define sqlite3_result_error_nomem sqlite_api->result_error_nomem
#define sqlite3_result_int sqlite_api->result_int
#define sqlite3_value_int sqlite_api->value_int
#define sqlite3_value_text sqlite_api->value_text
#define sqlite3_vfs_find sqlite_api->vfs_find
#define sqlite3_vfs_register sqlite_api->vfs_register
#define sqlite3_create_function_v2 sqlite_api->create_function_v2
#undef sqlite3_create_filename
#undef sqlite3_free_filename
#define sqlite3_create_filename sqlite_api->create_filename
#define sqlite3_free_filename sqlite_api->free_filename
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#include <dlfcn.h>
#include <pthread.h>
#ifndef F_OFD_SETLK
#error "Secure SQLite requires open-file-description locks (modern macOS/Linux)."
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
static char vfs_name[64];
#define PREFIX "/herdr-secure/"

typedef struct Root Root;
struct Root {
 char token[65]; char basename[32]; int directory; int mainfd; int readonly; int references; int registered;
 struct stat sidecars[3]; unsigned sidecar_known;
 Root *next;
};
typedef struct {
 sqlite3_file base;
 sqlite3_file *inner;
 sqlite3_filename filename;
 Root *root;
 int held;
 int delete_on_close;
 int lock_level;
 char suffix[16];
} File;
static sqlite3_vfs *underlying;
static sqlite3_vfs secure_vfs;
static Root *roots;
static sqlite3_mutex *mutex;
static void enter(void){sqlite3_mutex_enter(mutex);}
static void leave(void){sqlite3_mutex_leave(mutex);}
static void release(Root *r){
 if(!r)return;
 enter();
 if(--r->references==0){Root **p=&roots;while(*p && *p!=r)p=&(*p)->next;if(*p)*p=r->next;close(r->directory);close(r->mainfd);sqlite3_free(r);}
 leave();
}
static int safe_regular(int fd){struct stat s;return fstat(fd,&s)==0 && S_ISREG(s.st_mode) && s.st_uid==geteuid() && s.st_nlink==1 && (s.st_mode&077)==0;}
static int main_matches(Root *r){
 struct stat a,b;
 return fstat(r->mainfd,&a)==0 && fstatat(r->directory,r->basename,&b,AT_SYMLINK_NOFOLLOW)==0 && S_ISREG(b.st_mode) && a.st_dev==b.st_dev && a.st_ino==b.st_ino;
}
/* Acquires a root reference. The registered basename and ONLY its reserved
 * SQLite sidecars are capabilities; another basename never borrows this root. */
static Root *find_root(const char *name,const char **suffix){
 if(!name || strncmp(name,PREFIX,strlen(PREFIX)))return 0;
 const char *token=name+strlen(PREFIX),*slash=strchr(token,'/');
 if(!slash)return 0;
 size_t n=(size_t)(slash-token);
 Root *found=0;enter();
 for(Root *r=roots;r;r=r->next)if(strlen(r->token)==n && !memcmp(r->token,token,n)){
  size_t length=strlen(r->basename);
  if(strncmp(slash+1,r->basename,length))break;
  const char *s=slash+1+length;
  if(strcmp(s,"") && strcmp(s,"-journal") && strcmp(s,"-wal") && strcmp(s,"-shm"))break;
  r->references++;found=r;*suffix=s;break;
 }
 leave();return found;
}
static int sidecar_matches(Root*r,const char*s,const struct stat*st){
 int i=!strcmp(s,"-journal")?0:!strcmp(s,"-wal")?1:!strcmp(s,"-shm")?2:-1;
 if(i<0)return 0;enter();int known=r->sidecar_known&(1u<<i);
 int matches=!known || (r->sidecars[i].st_dev==st->st_dev && r->sidecars[i].st_ino==st->st_ino);
 if(matches && !known){r->sidecars[i]=*st;r->sidecar_known|=1u<<i;}leave();return matches;
}
static int close_file(sqlite3_file *p){
 File *f=(File*)p;int rc=f->inner->pMethods->xClose(f->inner);
 /* Logical deletion never unlinks a path that may have been replaced. Like
  * PERSIST/TRUNCATE journaling, a zero-length sidecar is reported as absent. */
 if(f->delete_on_close && f->root){if(!safe_regular(f->held) || ftruncate(f->held,0)!=0 || fsync(f->held)!=0)rc=SQLITE_IOERR_DELETE;}
 sqlite3_free(f->inner);if(f->filename)sqlite3_free_filename(f->filename);if(f->held>=0)close(f->held);release(f->root);f->base.pMethods=0;return rc;
}
static int read_file(sqlite3_file*p,void*b,int n,sqlite3_int64 o){File*f=(File*)p;return f->inner->pMethods->xRead(f->inner,b,n,o);}
static int write_file(sqlite3_file*p,const void*b,int n,sqlite3_int64 o){File*f=(File*)p;if(f->root && (f->root->readonly || !safe_regular(f->held)))return SQLITE_IOERR_WRITE;return f->inner->pMethods->xWrite(f->inner,b,n,o);}
static int truncate_file(sqlite3_file*p,sqlite3_int64 n){File*f=(File*)p;if(f->root && (f->root->readonly || !safe_regular(f->held)))return SQLITE_IOERR_TRUNCATE;return f->inner->pMethods->xTruncate(f->inner,n);}
static int sync_file(sqlite3_file*p,int flags){File*f=(File*)p;int rc=f->inner->pMethods->xSync(f->inner,flags);if(rc==SQLITE_OK && f->root && fsync(f->root->directory)!=0)rc=SQLITE_IOERR_DIR_FSYNC;return rc;}
static int size_file(sqlite3_file*p,sqlite3_int64*n){File*f=(File*)p;return f->inner->pMethods->xFileSize(f->inner,n);}
/* Standard SQLite rollback-lock bytes, held as OFD locks. POSIX process locks
 * would be silently released by closing ANY of our capability duplicates,
 * including a different connection's guard. OFD locks share the same conflict
 * ranges but belong to this connection's open-file description instead. */
#define PENDING_BYTE ((off_t)0x40000000)
#define RESERVED_BYTE (PENDING_BYTE+1)
#define SHARED_FIRST (PENDING_BYTE+2)
#define SHARED_SIZE 510
static int range_lock(File*f,short type,off_t start,off_t length){
 struct flock lock;memset(&lock,0,sizeof(lock));lock.l_type=type;lock.l_whence=SEEK_SET;lock.l_start=start;lock.l_len=length;
 int rc;do{rc=fcntl(f->held,F_OFD_SETLK,&lock);}while(rc<0 && errno==EINTR);
 return rc==0?SQLITE_OK:(errno==EACCES || errno==EAGAIN)?SQLITE_BUSY:SQLITE_IOERR_LOCK;
}
static int lock_file(sqlite3_file*p,int n){
 File*f=(File*)p;if(!f->root)return f->inner->pMethods->xLock(f->inner,n);
 if(n<=f->lock_level)return SQLITE_OK;int rc;
 if(f->lock_level==SQLITE_LOCK_NONE){
  rc=range_lock(f,F_RDLCK,PENDING_BYTE,1);if(rc!=SQLITE_OK)return rc;
  rc=range_lock(f,F_RDLCK,SHARED_FIRST,SHARED_SIZE);
  int released=range_lock(f,F_UNLCK,PENDING_BYTE,1);if(rc!=SQLITE_OK)return rc;if(released!=SQLITE_OK)return released;
  f->lock_level=SQLITE_LOCK_SHARED;
 }
 if(n==SQLITE_LOCK_SHARED)return SQLITE_OK;
 if(n==SQLITE_LOCK_RESERVED){rc=range_lock(f,F_WRLCK,RESERVED_BYTE,1);if(rc==SQLITE_OK)f->lock_level=n;return rc;}
 if(f->lock_level<SQLITE_LOCK_PENDING){rc=range_lock(f,F_WRLCK,PENDING_BYTE,1);if(rc!=SQLITE_OK)return rc;f->lock_level=SQLITE_LOCK_PENDING;}
 if(n==SQLITE_LOCK_PENDING)return SQLITE_OK;
 rc=range_lock(f,F_WRLCK,SHARED_FIRST,SHARED_SIZE);if(rc==SQLITE_OK)f->lock_level=SQLITE_LOCK_EXCLUSIVE;return rc;
}
static int unlock_file(sqlite3_file*p,int n){
 File*f=(File*)p;if(!f->root)return f->inner->pMethods->xUnlock(f->inner,n);
 if(n>=f->lock_level)return SQLITE_OK;int rc;
 if(n==SQLITE_LOCK_SHARED){
  rc=range_lock(f,F_RDLCK,SHARED_FIRST,SHARED_SIZE);if(rc!=SQLITE_OK)return rc;
  rc=range_lock(f,F_UNLCK,PENDING_BYTE,2);
 }else{rc=range_lock(f,F_UNLCK,PENDING_BYTE,SHARED_SIZE+2);}
 if(rc==SQLITE_OK)f->lock_level=n;return rc;
}
static int reserved_file(sqlite3_file*p,int*n){
 File*f=(File*)p;if(!f->root)return f->inner->pMethods->xCheckReservedLock(f->inner,n);
 if(f->lock_level>=SQLITE_LOCK_RESERVED){*n=1;return SQLITE_OK;}
 struct flock lock;memset(&lock,0,sizeof(lock));lock.l_type=F_WRLCK;lock.l_whence=SEEK_SET;lock.l_start=RESERVED_BYTE;lock.l_len=1;
 int rc;do{rc=fcntl(f->held,F_OFD_GETLK,&lock);}while(rc<0 && errno==EINTR);
 if(rc<0)return SQLITE_IOERR_CHECKRESERVEDLOCK;*n=lock.l_type!=F_UNLCK;return SQLITE_OK;
}
static int control_file(sqlite3_file*p,int op,void*arg){File*f=(File*)p;
 if(f->root && op==SQLITE_FCNTL_LOCKSTATE){*(int*)arg=f->lock_level;return SQLITE_OK;}
 if(f->root && op==SQLITE_FCNTL_HAS_MOVED){*(int*)arg=!main_matches(f->root);return SQLITE_OK;}
 if(op==SQLITE_FCNTL_VFS_POINTER){*(sqlite3_vfs**)arg=&secure_vfs;return SQLITE_OK;}
 return f->inner->pMethods->xFileControl(f->inner,op,arg);
}
static int sector_file(sqlite3_file*p){File*f=(File*)p;return f->inner->pMethods->xSectorSize(f->inner);}
static int characteristics_file(sqlite3_file*p){File*f=(File*)p;return f->inner->pMethods->xDeviceCharacteristics(f->inner);}
/* Version 1 intentionally exposes no shared-memory callbacks. Legacy WAL is
 * opened with locking_mode=EXCLUSIVE before the first read, using a heap index. */
static const sqlite3_io_methods methods={1,close_file,read_file,write_file,truncate_file,sync_file,size_file,lock_file,unlock_file,reserved_file,control_file,sector_file,characteristics_file,0,0,0,0,0,0};
static int open_file(sqlite3_vfs*v,const char*name,sqlite3_file*p,int flags,int*out){
 (void)v;File*f=(File*)p;memset(f,0,sizeof(*f));f->held=-1;
 f->inner=sqlite3_malloc(underlying->szOsFile);if(!f->inner)return SQLITE_NOMEM;memset(f->inner,0,underlying->szOsFile);
 const char*s="";Root*r=find_root(name,&s);f->root=r;
 int rc;
 if(!r){
  if(name && !strncmp(name,PREFIX,strlen(PREFIX))){sqlite3_free(f->inner);return SQLITE_CANTOPEN;}
  /* SQLite's own unnamed temporary files keep their standard VFS semantics. */
  rc=underlying->xOpen(underlying,name,f->inner,flags,out);
 }else{
  if(!main_matches(r) || (!*s && !r->registered)){rc=SQLITE_READONLY_DBMOVED;goto failed;}
  if(!strcmp(s,"-shm")){rc=SQLITE_CANTOPEN;goto failed;}
  if(r->readonly && (flags&SQLITE_OPEN_READWRITE)){rc=SQLITE_READONLY;goto failed;}
  if(!*s){f->held=fcntl(r->mainfd,F_DUPFD_CLOEXEC,0);}else{
   if(r->readonly && (flags & SQLITE_OPEN_READWRITE)){rc=SQLITE_READONLY;goto failed;}
   char child[64];snprintf(child,sizeof(child),"%s%s",r->basename,s);
   int mode=(flags&SQLITE_OPEN_READONLY)?O_RDONLY:O_RDWR;
   if(flags&SQLITE_OPEN_CREATE)mode|=O_CREAT;
   if(flags&SQLITE_OPEN_EXCLUSIVE)mode|=O_EXCL;
   f->held=openat(r->directory,child,mode|O_NOFOLLOW|O_CLOEXEC,0600);
  }
  if(f->held<0 || !safe_regular(f->held)){rc=SQLITE_CANTOPEN;goto failed;}
  if(*s){struct stat st;if(fstat(f->held,&st)!=0 || !sidecar_matches(r,s,&st)){rc=SQLITE_IOERR;goto failed;}}
  strcpy(f->suffix,s);f->delete_on_close=!!(flags&SQLITE_OPEN_DELETEONCLOSE);
  char fdpath[64];
#ifdef __APPLE__
  snprintf(fdpath,sizeof(fdpath),"/dev/fd/%d",f->held);
#else
  snprintf(fdpath,sizeof(fdpath),"/proc/self/fd/%d",f->held);
#endif
  /* The held file already exists. Treat it as a main file so the underlying
   * VFS never derives directory-sync or cleanup paths from the fd alias. Our
   * wrapper performs those operations through the held directory instead. */
  int inner_flags=SQLITE_OPEN_MAIN_DB|((flags&SQLITE_OPEN_READONLY)?SQLITE_OPEN_READONLY:SQLITE_OPEN_READWRITE);
  /* xOpen retains sqlite3_filename until xClose and may inspect its URI
   * parameters even without URI flags. Allocate it using the public API. */
  f->filename=sqlite3_create_filename(fdpath,"","",0,0);if(!f->filename){rc=SQLITE_NOMEM;goto failed;}
  rc=underlying->xOpen(underlying,f->filename,f->inner,inner_flags,out);
 }
 if(rc!=SQLITE_OK)goto failed;
 f->base.pMethods=&methods;return SQLITE_OK;
 failed:
 if(f->inner->pMethods)f->inner->pMethods->xClose(f->inner);
 sqlite3_free(f->inner);if(f->filename)sqlite3_free_filename(f->filename);if(f->held>=0)close(f->held);release(r);return rc;
}
static int delete_file(sqlite3_vfs*v,const char*name,int sync_dir){
 (void)v;const char*s="";Root*r=find_root(name,&s);
 if(!r)return name && !strncmp(name,PREFIX,strlen(PREFIX))?SQLITE_CANTOPEN:underlying->xDelete(underlying,name,sync_dir);
 if(!*s || r->readonly){release(r);return SQLITE_IOERR_DELETE;}
 char child[64];snprintf(child,sizeof(child),"%s%s",r->basename,s);
 int fd=openat(r->directory,child,O_WRONLY|O_NOFOLLOW|O_CLOEXEC);
 if(fd<0){int rc=errno==ENOENT?SQLITE_OK:SQLITE_IOERR_DELETE;release(r);return rc;}
 struct stat st;int rc=SQLITE_OK;
 if(!safe_regular(fd) || fstat(fd,&st)!=0 || !sidecar_matches(r,s,&st))rc=SQLITE_IOERR_DELETE;
 else if(ftruncate(fd,0)!=0 || fsync(fd)!=0)rc=SQLITE_IOERR_DELETE;
 close(fd);
 if(rc==SQLITE_OK && sync_dir && fsync(r->directory)!=0)rc=SQLITE_IOERR_DIR_FSYNC;
 release(r);return rc;
}
static int access_file(sqlite3_vfs*v,const char*name,int mode,int*out){
 (void)v;const char*s="";Root*r=find_root(name,&s);
 if(!r)return name && !strncmp(name,PREFIX,strlen(PREFIX))?SQLITE_CANTOPEN:underlying->xAccess(underlying,name,mode,out);
 char child[64];snprintf(child,sizeof(child),"%s%s",r->basename,s);struct stat st;
 *out=0;
 if(fstatat(r->directory,child,&st,AT_SYMLINK_NOFOLLOW)==0){
  if(!S_ISREG(st.st_mode) || st.st_uid!=geteuid() || st.st_nlink!=1 || (st.st_mode&077)!=0 || (*s && !sidecar_matches(r,s,&st))){release(r);return SQLITE_IOERR_ACCESS;}
  *out=mode!=SQLITE_ACCESS_EXISTS || st.st_size>0;
 }
 if(mode==SQLITE_ACCESS_READWRITE && r->readonly)*out=0;
 release(r);return SQLITE_OK;
}
static int full_path(sqlite3_vfs*v,const char*name,int n,char*out){
 (void)v;if(name && !strncmp(name,PREFIX,strlen(PREFIX))){if(strlen(name)>=(size_t)n)return SQLITE_CANTOPEN;memcpy(out,name,strlen(name)+1);return SQLITE_OK;}
 return underlying->xFullPathname(underlying,name,n,out);
}
static void*dl_open(sqlite3_vfs*v,const char*n){(void)v;return underlying->xDlOpen(underlying,n);}
static void dl_error(sqlite3_vfs*v,int n,char*b){(void)v;underlying->xDlError(underlying,n,b);}
static void(*dl_sym(sqlite3_vfs*v,void*h,const char*n))(void){(void)v;return underlying->xDlSym(underlying,h,n);}
static void dl_close(sqlite3_vfs*v,void*h){(void)v;underlying->xDlClose(underlying,h);}
static int randomness(sqlite3_vfs*v,int n,char*b){(void)v;return underlying->xRandomness(underlying,n,b);}
static int sleep_vfs(sqlite3_vfs*v,int n){(void)v;return underlying->xSleep(underlying,n);}
static int current_time(sqlite3_vfs*v,double*t){(void)v;return underlying->xCurrentTime(underlying,t);}
static int last_error(sqlite3_vfs*v,int n,char*b){(void)v;return underlying->xGetLastError?underlying->xGetLastError(underlying,n,b):0;}
static int current_time64(sqlite3_vfs*v,sqlite3_int64*t){(void)v;if(underlying->iVersion>=2 && underlying->xCurrentTimeInt64)return underlying->xCurrentTimeInt64(underlying,t);double d;int rc=underlying->xCurrentTime(underlying,&d);*t=(sqlite3_int64)(d*86400000.0);return rc;}
static int valid_token(const char*t){if(!t || !*t || strlen(t)>64)return 0;for(;*t;t++)if(!(*t>='a'&&*t<='z') && !(*t>='0'&&*t<='9') && *t!='-')return 0;return 1;}
/* Deliberately not a general pathname API: these are the two reviewed stores. */
static int valid_basename(const char*name){return name && (!strcmp(name,"herdr.db") || !strcmp(name,"scheduling.sqlite"));}
int herdr_register_root(const char*token,int directory,int mainfd,int readonly,const char*basename){
 if(!valid_token(token) || !valid_basename(basename))return SQLITE_MISUSE;
 Root*r=sqlite3_malloc(sizeof(*r));if(!r)return SQLITE_NOMEM;memset(r,0,sizeof(*r));
 strcpy(r->token,token);strcpy(r->basename,basename);r->directory=fcntl(directory,F_DUPFD_CLOEXEC,0);r->mainfd=fcntl(mainfd,F_DUPFD_CLOEXEC,0);r->readonly=readonly!=0;
 struct stat ds;
 int valid=r->directory>=0 && r->mainfd>=0 && fstat(r->directory,&ds)==0 && S_ISDIR(ds.st_mode) && ds.st_uid==geteuid() && safe_regular(r->mainfd) && main_matches(r);
 const char*suffixes[]={"-journal","-wal","-shm"};
 for(int i=0;valid && i<3;i++){
  char child[64];struct stat st;snprintf(child,sizeof(child),"%s%s",r->basename,suffixes[i]);
  if(fstatat(r->directory,child,&st,AT_SYMLINK_NOFOLLOW)==0){
   valid=S_ISREG(st.st_mode) && st.st_uid==geteuid() && st.st_nlink==1 && (st.st_mode&077)==0;
   if(valid){r->sidecars[i]=st;r->sidecar_known|=1u<<i;}
  }else if(errno!=ENOENT)valid=0;
 }
 if(!valid){
  if(r->directory>=0)close(r->directory);if(r->mainfd>=0)close(r->mainfd);sqlite3_free(r);return SQLITE_CANTOPEN;
 }
 enter();for(Root*p=roots;p;p=p->next)if(!strcmp(p->token,token)){leave();close(r->directory);close(r->mainfd);sqlite3_free(r);return SQLITE_MISUSE;}
 r->references=1;r->registered=1;r->next=roots;roots=r;leave();return SQLITE_OK;
}
int herdr_unregister_root(const char*t){
 Root*found=0;enter();for(Root*r=roots;r;r=r->next)if(t && r->registered && !strcmp(r->token,t)){r->registered=0;found=r;break;}leave();release(found);return found?SQLITE_OK:SQLITE_NOTFOUND;
}
static void register_root(sqlite3_context*c,int n,sqlite3_value**a){
 int rc=herdr_register_root((const char*)sqlite3_value_text(a[0]),sqlite3_value_int(a[1]),sqlite3_value_int(a[2]),sqlite3_value_int(a[3]),n==5?(const char*)sqlite3_value_text(a[4]):"herdr.db");
 if(rc!=SQLITE_OK)sqlite3_result_error(c,"secure VFS capability mismatch",-1);else sqlite3_result_int(c,1);
}
static void unregister_root(sqlite3_context*c,int n,sqlite3_value**a){(void)n;sqlite3_result_int(c,herdr_unregister_root((const char*)sqlite3_value_text(a[0]))==SQLITE_OK);}
#ifdef _WIN32
__declspec(dllexport)
#endif
static int initialize_vfs(sqlite3*db,char**error,const sqlite3_api_routines*api){
 if(sqlite_api && sqlite_api->vfs_find(0)!=api->vfs_find(0))return SQLITE_MISMATCH;
 if(!sqlite_api)sqlite_api=api;(void)error;
 if(!underlying){
  underlying=sqlite3_vfs_find(0);if(!underlying)return SQLITE_ERROR;
  mutex=sqlite3_mutex_alloc(SQLITE_MUTEX_FAST);if(!mutex){underlying=0;return SQLITE_NOMEM;}
  memset(&secure_vfs,0,sizeof(secure_vfs));secure_vfs.iVersion=2;secure_vfs.szOsFile=sizeof(File);secure_vfs.mxPathname=underlying->mxPathname;secure_vfs.zName=vfs_name;
  unsigned char random[16];if(underlying->xRandomness(underlying,16,(char*)random)!=16){underlying=0;return SQLITE_ERROR;}
  strcpy(vfs_name,"herdr-secure-");for(int i=0;i<16;i++)snprintf(vfs_name+13+2*i,3,"%02x",random[i]);
  secure_vfs.xOpen=open_file;secure_vfs.xDelete=delete_file;secure_vfs.xAccess=access_file;secure_vfs.xFullPathname=full_path;secure_vfs.xDlOpen=dl_open;secure_vfs.xDlError=dl_error;secure_vfs.xDlSym=dl_sym;secure_vfs.xDlClose=dl_close;secure_vfs.xRandomness=randomness;secure_vfs.xSleep=sleep_vfs;secure_vfs.xCurrentTime=current_time;secure_vfs.xGetLastError=last_error;secure_vfs.xCurrentTimeInt64=current_time64;
  int rc=sqlite3_vfs_register(&secure_vfs,0);if(rc!=SQLITE_OK)return rc;
 }
 if(!db)return SQLITE_OK;
 int flags=SQLITE_UTF8|SQLITE_DIRECTONLY;
 int rc=sqlite3_create_function_v2(db,"herdr_guard_register",4,flags,0,register_root,0,0,0);
 if(rc!=SQLITE_OK)return rc;
 rc=sqlite3_create_function_v2(db,"herdr_guard_register",5,flags,0,register_root,0,0,0);
 if(rc!=SQLITE_OK)return rc;
 return sqlite3_create_function_v2(db,"herdr_guard_unregister",1,flags,0,unregister_root,0,0,0);
}

static pthread_mutex_t initialize_mutex=PTHREAD_MUTEX_INITIALIZER;
int sqlite3_extension_init(sqlite3*db,char**error,const sqlite3_api_routines*api){
 pthread_mutex_lock(&initialize_mutex);int rc=initialize_vfs(db,error,api);pthread_mutex_unlock(&initialize_mutex);return rc;
}

/* macOS's system SQLite omits loadExtension. Bind its public API directly,
 * ONLY after proving it is the very VFS instance already used by Bun. This
 * never changes SQLite libraries or passes a Bun handle to a different copy. */
static sqlite3_api_routines direct_api;
static int direct_bound;
static int bind_library(const char*library,sqlite3_vfs*expected){
 if(direct_bound)return direct_api.vfs_find(0)==expected?SQLITE_OK:SQLITE_MISMATCH;
 void*handle=dlopen(library,RTLD_NOW|RTLD_LOCAL);if(!handle)return SQLITE_CANTOPEN;
 sqlite3_vfs*(*find)(const char*);void*symbol=dlsym(handle,"sqlite3_vfs_find");memcpy(&find,&symbol,sizeof(find));
 if(!find || find(0)!=expected){dlclose(handle);return SQLITE_MISMATCH;}
#define BIND(field,sym) do {void*p=dlsym(handle,sym);if(!p){dlclose(handle);return SQLITE_NOTFOUND;}memcpy(&direct_api.field,&p,sizeof(p));}while(0)
 BIND(malloc,"sqlite3_malloc");BIND(free,"sqlite3_free");
 BIND(mutex_alloc,"sqlite3_mutex_alloc");BIND(mutex_enter,"sqlite3_mutex_enter");BIND(mutex_leave,"sqlite3_mutex_leave");
 BIND(result_error,"sqlite3_result_error");BIND(result_error_nomem,"sqlite3_result_error_nomem");BIND(result_int,"sqlite3_result_int");
 BIND(value_int,"sqlite3_value_int");BIND(value_text,"sqlite3_value_text");
 BIND(vfs_find,"sqlite3_vfs_find");BIND(vfs_register,"sqlite3_vfs_register");BIND(create_function_v2,"sqlite3_create_function_v2");
 BIND(create_filename,"sqlite3_create_filename");BIND(free_filename,"sqlite3_free_filename");
#undef BIND
 int rc=sqlite3_extension_init(0,0,&direct_api);if(rc==SQLITE_OK)direct_bound=1;return rc;
}
const char*herdr_vfs_name(void){return vfs_name;}
/* SQLite owns registered callbacks process-wide, beyond any JS worker or DB.
 * Retain a loader reference explicitly; never rely on a JS object's GC life. */
static void*own_handle;
int herdr_pin_library(const char*file){pthread_mutex_lock(&initialize_mutex);if(!own_handle)own_handle=dlopen(file,RTLD_NOW|RTLD_LOCAL);int rc=own_handle?SQLITE_OK:SQLITE_CANTOPEN;pthread_mutex_unlock(&initialize_mutex);return rc;}
static pthread_mutex_t bind_mutex=PTHREAD_MUTEX_INITIALIZER;
int herdr_bind_library(const char*library,sqlite3_vfs*expected){pthread_mutex_lock(&bind_mutex);int rc=bind_library(library,expected);pthread_mutex_unlock(&bind_mutex);return rc;}
