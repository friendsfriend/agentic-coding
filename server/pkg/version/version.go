package version

// Version is the environment backend version. The default matches the product
// version in the repository root package.json; packaged builds overwrite it
// with `-ldflags -X` from that same one version source (scripts/build.ts).
var Version = "0.12.7"
