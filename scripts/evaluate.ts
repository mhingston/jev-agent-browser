import { calibrationReport } from "../src/evaluation.js";

const report = calibrationReport([
  { probability: 0.95, outcome: true },
  { probability: 0.8, outcome: true },
  { probability: 0.7, outcome: false },
  { probability: 0.25, outcome: false },
  { probability: 0.1, outcome: false },
  { probability: 0.55, outcome: true },
]);

console.log(JSON.stringify(report, null, 2));
