/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "shared-no-upper-layers",
      severity: "error",
      from: { path: "^extension-src/omp-theme/shared/" },
      to: { path: "^extension-src/omp-theme/(domain|features|app|pi)/" },
    },
    {
      name: "domain-no-upper-layers",
      severity: "error",
      from: { path: "^extension-src/omp-theme/domain/" },
      to: { path: "^extension-src/omp-theme/(features|app|pi)/" },
    },
    {
      name: "features-no-upper-layers",
      severity: "error",
      from: { path: "^extension-src/omp-theme/features/" },
      to: { path: "^extension-src/omp-theme/(app|pi)/" },
    },
    {
      name: "app-no-pi",
      severity: "error",
      from: { path: "^extension-src/omp-theme/app/" },
      to: { path: "^extension-src/omp-theme/pi/" },
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
