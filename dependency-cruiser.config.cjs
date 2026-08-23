/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "shared-no-upper-layers",
      severity: "error",
      from: { path: "^extension-src/pi-omp-theme/shared/" },
      to: { path: "^extension-src/pi-omp-theme/(domain|features|app|pi)/" },
    },
    {
      name: "domain-no-upper-layers",
      severity: "error",
      from: { path: "^extension-src/pi-omp-theme/domain/" },
      to: { path: "^extension-src/pi-omp-theme/(features|app|pi)/" },
    },
    {
      name: "features-no-upper-layers",
      severity: "error",
      from: { path: "^extension-src/pi-omp-theme/features/" },
      to: { path: "^extension-src/pi-omp-theme/(app|pi)/" },
    },
    {
      name: "app-no-pi",
      severity: "error",
      from: { path: "^extension-src/pi-omp-theme/app/" },
      to: { path: "^extension-src/pi-omp-theme/pi/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "default"],
    },
  },
};
