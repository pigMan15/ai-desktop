const path = require("node:path");

const root = path.resolve(__dirname, "../..");

module.exports = {
  appId: "cn.local.aiworkflow.platform",
  productName: "AI Workflow Platform",
  electronVersion: "31.7.7",
  electronDist: path.join(root, "node_modules", "electron", "dist"),
  npmRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    output: process.env.PACKAGE_OUTPUT_DIR || path.join(root, "release")
  },
  files: [
    "dist/**/*",
    "package.json",
    {
      from: path.join(root, "apps", "renderer", "dist"),
      to: "renderer/dist"
    }
  ],
  extraResources: [
    {
      from: path.join(root, "runtime", "dist", "workflow-runtime"),
      to: "runtime",
      filter: ["**/*"]
    }
  ],
  win: {
    signAndEditExecutable: false,
    forceCodeSigning: false,
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true
  }
};
