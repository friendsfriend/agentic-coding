// The migration recognizes this reviewed source version, not arbitrary shell
// programs with a matching filename. Changed/extra effects require reconciliation.
export const hostBuildSourceDigest =
	"9238c522acb60f86cd912b694d5eee8172ac5f5c9e8f38eec116438f68c4068e";
export const hostBuildDockerfile = `FROM eclipse-temurin:25-jre
WORKDIR /app
COPY dependencies/ ./
COPY spring-boot-loader/ ./
COPY snapshot-dependencies/ ./
COPY application/ ./
EXPOSE 8080
ENTRYPOINT ["java","-Dplaywright.cli.dir=/playwright-driver","org.springframework.boot.loader.launch.JarLauncher"]
`;
