FROM bbernhard/signal-cli-rest-api:latest

USER root

# Install curl for Supabase backup/restore
RUN apt-get update && apt-get install -y curl tar && rm -rf /var/lib/apt/lists/*

# json-rpc mode keeps ONE persistent signal-cli process instead of
# spawning a new JVM on every request — fixes the 512MB OOM crash
ENV MODE=json-rpc
ENV JAVA_TOOL_OPTIONS="-Xms32m -Xmx180m"

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
