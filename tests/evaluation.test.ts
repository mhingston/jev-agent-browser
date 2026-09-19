import { describe, expect, it } from "vitest";
import { brierScore, calibrationReport, reliabilityBins } from "../src/evaluation.js";

describe("Jev confidence evaluation", () => {
  it("computes Brier score and reliability bins", () => {
    const samples = [
      { probability: 0.9, outcome: true },
      { probability: 0.8, outcome: false },
      { probability: 0.1, outcome: false },
      { probability: 0.2, outcome: true },
    ];
    expect(brierScore(samples)).toBeCloseTo(0.325);
    const bins = reliabilityBins(samples, 2);
    expect(bins[0].count).toBe(2);
    expect(bins[1].count).toBe(2);
    expect(calibrationReport(samples, 2).expectedCalibrationError).toBeGreaterThan(0);
  });

  it("rejects invalid probabilities", () => {
    expect(() => brierScore([{ probability: 1.2, outcome: true }])).toThrow(/between 0 and 1/);
    expect(() => reliabilityBins([], 0)).toThrow(/positive integer/);
  });
});
