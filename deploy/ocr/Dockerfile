ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS qualification
ARG SUBJECT_SHA
ARG SUBJECT_TREE
ARG WORKFLOW_SHA
LABEL org.opencontainers.image.revision=${SUBJECT_SHA} \
      io.reformaflow.subject.tree=${SUBJECT_TREE} \
      io.reformaflow.workflow.sha=${WORKFLOW_SHA}

WORKDIR /opt/qualification
ENV NODE_ENV=qualification \
    CI=1 \
    HOME=/home/node \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node . /opt/qualification

RUN npm ci --no-audit --no-fund --include=dev \
  && npm --workspace @reformaflow/domain run build \
  && npx prisma generate --schema=prisma/schema.prisma \
  && npm --workspace @reformaflow/api run build \
  && node --check scripts/ci/ocr-attestation.mjs \
  && node --check scripts/ci/ocr-runtime-subject.mjs \
  && node --check scripts/ci/ocr-recovery-evidence.mjs \
  && node --check deploy/ocr/qualification-entrypoint.mjs \
  && node --check deploy/ocr/wif-adapter.mjs \
  && node --check deploy/ocr/verify-reviews.mjs \
  && node --check deploy/ocr/github-approval-evidence.mjs \
  && node --check deploy/ocr/build-unsigned-attestation.mjs \
  && node --check deploy/ocr/evidence-bundle.mjs \
  && node --check deploy/ocr/offline-report-adapter.mjs \
  && node --check deploy/ocr/artifact-digest.mjs \
  && node --check deploy/ocr/external-producer-gate.mjs \
  && node --check deploy/ocr/kms-curl-config.mjs \
  && node --check deploy/ocr/workflow-payload-template.mjs \
  && node --check deploy/ocr/oci-layout.mjs \
  && node --check deploy/ocr/executable-closure.mjs \
  && chown -R node:node /opt/qualification

USER node
ENTRYPOINT ["node", "deploy/ocr/qualification-entrypoint.mjs"]
