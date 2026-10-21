# The normal-app component. It intentionally has NO host repair authority.
# Native host deployments continue to use deploy/*.service, not this entrypoint.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY web ./web
COPY REPAIR_PROMPT.md ./
RUN mkdir /state && chown 1000:1000 /state
ENV TROUBLESHOOT_CONTAINER=1 TROUBLESHOOT_STATE=/state PORT=9691
USER 1000:1000
EXPOSE 9691
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:9691/troubleshoot/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
