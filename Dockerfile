FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Fonts used by the caption styles (Poppins, Anton). If the download fails, the build still works with a fallback font.
RUN mkdir -p /usr/share/fonts/truetype/tc && cd /usr/share/fonts/truetype/tc \
 && for f in poppins/Poppins-Regular poppins/Poppins-Bold poppins/Poppins-SemiBold anton/Anton-Regular 'montserrat/Montserrat%5Bwght%5D'; do \
      curl -fsSL -o "$(basename "$f" | sed "s/%5B/[/;s/%5D/]/").ttf" "https://github.com/google/fonts/raw/main/ofl/$f.ttf" || true; done \
 && fc-cache -f
# Run as a normal user (required by Hugging Face Spaces)
USER node
WORKDIR /home/node/app
COPY --chown=node . .
ENV PORT=7860 NODE_ENV=production
EXPOSE 7860
CMD ["node", "server/index.js"]
