FROM bbernhard/signal-cli-rest-api:latest

USER root

# Install curl for Supabase backup/restore
RUN apt-get update && apt-get install -y curl tar && rm -rf /var/lib/apt/lists/*

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
