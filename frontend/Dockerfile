# Use a Node.js image suitable for development
FROM node:20-slim

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json .
COPY package-lock.json .
COPY tailwind.config.js .
COPY postcss.config.js .

# Install dependencies
RUN npm install

# Copy all the rest of your frontend code
COPY . .

# Expose the default port for the Create React App development server
EXPOSE 3000

# The default command when the container starts is to run the development server
# NOTE: This command is redundant if specified in docker-compose.yml, but serves as a good default.
CMD ["npm", "start"]