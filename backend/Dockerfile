# syntax=docker/dockerfile:1.7

FROM golang:1.25-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags="-s -w" -o /out/agentflow-backend .

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agentflow \
    && useradd --uid 10001 --gid 10001 --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin agentflow

WORKDIR /app
COPY --from=build --chown=10001:10001 /out/agentflow-backend /usr/local/bin/agentflow-backend
COPY --chown=10001:10001 platform.xml /app/platform.xml

ENV PLATFORM_XML_PATH=/app/platform.xml \
    RG_PATH=/usr/bin/rg

USER 10001:10001
EXPOSE 9090 9091
ENTRYPOINT ["/usr/local/bin/agentflow-backend"]
