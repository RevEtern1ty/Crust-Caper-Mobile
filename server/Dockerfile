FROM eclipse-temurin:21-jdk-jammy@sha256:b2711c65970c1227197c29c46e669bfdbb137524e9da0e664703a140ec25a040 AS build
WORKDIR /source
COPY gradle ./gradle
COPY gradlew build.gradle settings.gradle ./
RUN sh ./gradlew --no-daemon dependencies --configuration runtimeClasspath
COPY src ./src
RUN sh ./gradlew --no-daemon bootJar

FROM eclipse-temurin:21-jre-jammy@sha256:a8bff88f760e87e0c8844f8461f807c203fd5e8f78c951c843024647e965eaf5
WORKDIR /app
COPY --from=build --chown=10001:10001 /source/build/libs/crustcaper-api.jar /app/app.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
