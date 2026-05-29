FROM bbernhard/signal-cli-rest-api:latest

USER root

# Install curl for Supabase backup/restore
RUN apt-get update && apt-get install -y curl tar && rm -rf /var/lib/apt/lists/*

# JAVA_TOOL_OPTIONS is auto-picked up by ANY JVM — limits signal-cli heap
# JAVA_OPTS alone is ignored unless the startup script passes it explicitly
ENV JAVA_TOOL_OPTIONS="-Xms32m -Xmx180m"
ENV _JAVA_OPTIONS="-Xms32m -Xmx180m"

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
