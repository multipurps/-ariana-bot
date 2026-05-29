FROM bbernhard/signal-cli-rest-api:latest

USER root

# Install curl for Supabase backup/restore
RUN apt-get update && apt-get install -y curl tar && rm -rf /var/lib/apt/lists/*

# Keep memory under Render free tier 512MB limit
ENV JAVA_OPTS="-Xms64m -Xmx256m"

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
