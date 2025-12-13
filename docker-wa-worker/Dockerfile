FROM node:20-alpine

# system deps
RUN apk add --no-cache git

WORKDIR /app

# config files
COPY package.json tsconfig.json ./

# install deps
RUN npm install

# app code
COPY index.ts ./

# sessions dir (volume mapping)
RUN mkdir sessions

# NOTE: No EXPOSE by default for production security
# In debug mode, use: docker run -p 3001:3001 -e ENABLE_API_SERVER=true ...

CMD ["npm", "start"]
