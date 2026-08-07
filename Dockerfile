# syntax=docker/dockerfile:1
# Build stage: install the bundled (not publicly published) kakoen artifact,
# then build the shaded fat jar.
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY valheim-save-tools-fixed.jar .
RUN mvn -q install:install-file -Dfile=valheim-save-tools-fixed.jar \
    -DgroupId=net.kakoen.valheim -DartifactId=valheim-save-tools \
    -Dversion=1.0-fixed -Dpackaging=jar
COPY viewer/pom.xml viewer/pom.xml
RUN mvn -q -f viewer/pom.xml dependency:go-offline
COPY viewer/src viewer/src
RUN mvn -q -f viewer/pom.xml package -DskipTests

# Runtime: Debian-based JRE (DuckDB JDBC needs glibc), headless AWT for the
# PNG layer renderer. /app is the CWD so classification.json and
# steward-config.json resolve; StConfig may rewrite the latter, so it stays
# writable.
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY --from=build /build/viewer/target/world-viewer-1.0.0.jar /app/world-viewer.jar
COPY viewer/classification.json viewer/steward-config.json /app/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENV JAVA_OPTS="-Xmx6g -Djava.awt.headless=true"
EXPOSE 8003
ENTRYPOINT ["/app/entrypoint.sh"]
