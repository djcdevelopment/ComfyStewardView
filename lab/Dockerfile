# syntax=docker/dockerfile:1
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build

COPY pom.xml ./pom.xml
RUN mvn -B -q -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:17-jre-jammy
WORKDIR /app

RUN groupadd --gid 10001 steward \
    && useradd --uid 10001 --gid steward --no-create-home --shell /usr/sbin/nologin steward
COPY --from=build /build/target/steward-spatial-lab-0.1.0-SNAPSHOT.jar /app/steward-spatial-lab.jar
COPY entrypoint-public.sh /app/entrypoint-public.sh
RUN chmod 0555 /app/entrypoint-public.sh \
    && chown -R steward:steward /app

USER 10001:10001
ENV JAVA_OPTS="-Xms256m -Xmx1g -Djava.awt.headless=true"
EXPOSE 8091
ENTRYPOINT ["/app/entrypoint-public.sh"]
