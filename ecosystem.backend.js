const path = require("path");

const projectRoot = path.resolve(__dirname);
const backendDir = path.join(projectRoot, "Backend");

module.exports = {
  apps: [
    {
      name: "gestionloyer-backend",
      cwd: backendDir,
      script: "npm",
      args: "run dev",
      env: {
        NODE_ENV: "development",
        PORT: 4013,
        CORS_ORIGIN: "https://gestionloyer.agishalabs.tech",
      },
      watch: false,
    },
  ],
};

