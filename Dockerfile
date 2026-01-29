FROM denoland/deno:alpine-2.3.5

WORKDIR /app

COPY import_map.json deno.jsonc ./

COPY ./src ./src

RUN deno cache ./src/main.ts
RUN ls -l src/main.ts

ENTRYPOINT ["deno"]
CMD ["run", "-A", "src/main.ts"]
