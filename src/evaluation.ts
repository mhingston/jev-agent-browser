export interface EvaluationSample {
  probability: number;
  outcome: boolean;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanProbability: number;
  empiricalRate: number;
}

export interface CalibrationReport {
  count: number;
  brierScore: number;
  expectedCalibrationError: number;
  bins: ReliabilityBin[];
}

function validate(samples: EvaluationSample[]): void {
  for (const sample of samples) {
    if (!Number.isFinite(sample.probability) || sample.probability < 0 || sample.probability > 1) {
      throw new Error("probability must be between 0 and 1");
    }
  }
}

export function brierScore(samples: EvaluationSample[]): number {
  validate(samples);
  if (!samples.length) return 0;
  return samples.reduce((sum, sample) => sum + (sample.probability - (sample.outcome ? 1 : 0)) ** 2, 0) / samples.length;
}

export function reliabilityBins(samples: EvaluationSample[], binCount = 10): ReliabilityBin[] {
  validate(samples);
  if (!Number.isInteger(binCount) || binCount < 1) throw new Error("binCount must be a positive integer");
  return Array.from({ length: binCount }, (_, index) => {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const inBin = samples.filter((sample) => sample.probability >= lower && (index === binCount - 1 ? sample.probability <= upper : sample.probability < upper));
    return {
      lower,
      upper,
      count: inBin.length,
      meanProbability: inBin.length ? inBin.reduce((sum, sample) => sum + sample.probability, 0) / inBin.length : 0,
      empiricalRate: inBin.length ? inBin.filter((sample) => sample.outcome).length / inBin.length : 0,
    };
  });
}

export function calibrationReport(samples: EvaluationSample[], binCount = 10): CalibrationReport {
  const bins = reliabilityBins(samples, binCount);
  const expectedCalibrationError = samples.length
    ? bins.reduce((sum, bin) => sum + (bin.count / samples.length) * Math.abs(bin.meanProbability - bin.empiricalRate), 0)
    : 0;
  return { count: samples.length, brierScore: brierScore(samples), expectedCalibrationError, bins };
}
