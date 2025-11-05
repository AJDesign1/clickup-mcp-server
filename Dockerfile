FROM node:20-alpine

WORKDIR /app

# copy package files first
COPY package*.json ./

# install deps (use npm install, not npm ci, so we don't care about a perfect lockfile)
RUN npm install

# copy the rest of the code
COPY . .

# tell node it's production
ENV NODE_ENV=production

# Render will give us PORT, but default to 8080
ENV PORT=8080

EXPOSE 8080

# start our HTTP wrapper
CMD ["node", "server.js"]
