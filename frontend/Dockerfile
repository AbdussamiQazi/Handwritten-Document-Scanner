# Stage 1: Build the React Application
FROM node:20-slim as builder

WORKDIR /app

COPY package*.json ./
# If you have tailwind, keep these, otherwise ignore
COPY tailwind.config.js .
COPY postcss.config.js .

RUN npm install

COPY . .

# --- CHANGED FOR NORMAL REACT (CRA) ---
# 1. Use REACT_APP_ prefix
# 2. Accept it as a build argument
ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=$REACT_APP_API_URL

# Build the app
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:alpine

# --- FIXED: COPY FROM 'build' INSTEAD OF 'dist' ---
COPY --from=builder /app/build /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]