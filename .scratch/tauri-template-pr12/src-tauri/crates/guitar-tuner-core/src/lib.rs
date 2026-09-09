use audio_analysis_pitch::{
    AutocorrelationPitchDetector, PitchDetectorConfig, PitchEstimate, PitchSmoother,
};
use serde::Serialize;

const IN_TUNE_CENTS: f32 = 5.0;
const MAX_INPUT_SAMPLES: usize = 32_768;
const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 192_000;

#[derive(Debug, Clone, Copy)]
struct TargetString {
    name: &'static str,
    frequency_hz: f32,
}

const STANDARD_TUNING: [TargetString; 6] = [
    TargetString {
        name: "E2",
        frequency_hz: 82.4069,
    },
    TargetString {
        name: "A2",
        frequency_hz: 110.0,
    },
    TargetString {
        name: "D3",
        frequency_hz: 146.8324,
    },
    TargetString {
        name: "G3",
        frequency_hz: 195.9977,
    },
    TargetString {
        name: "B3",
        frequency_hz: 246.9417,
    },
    TargetString {
        name: "E4",
        frequency_hz: 329.6276,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TuningStatus {
    Listening,
    InTune,
    Flat,
    Sharp,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningReading {
    pub detected_frequency_hz: Option<f32>,
    pub detected_note: Option<String>,
    pub target_string: Option<String>,
    pub target_frequency_hz: Option<f32>,
    pub cents: Option<f32>,
    pub confidence: f32,
    pub status: TuningStatus,
}

impl TuningReading {
    fn listening(confidence: f32) -> Self {
        Self {
            detected_frequency_hz: None,
            detected_note: None,
            target_string: None,
            target_frequency_hz: None,
            cents: None,
            confidence,
            status: TuningStatus::Listening,
        }
    }
}

pub struct GuitarTuner {
    detector: AutocorrelationPitchDetector,
    smoother: PitchSmoother,
}

impl GuitarTuner {
    pub fn new() -> Result<Self, String> {
        let detector = AutocorrelationPitchDetector::new(PitchDetectorConfig {
            min_frequency_hz: 60.0,
            max_frequency_hz: 380.0,
            confidence_threshold: 0.6,
        })
        .map_err(|error| error.to_string())?;
        let smoother = PitchSmoother::new(5).map_err(|error| error.to_string())?;
        Ok(Self { detector, smoother })
    }

    pub fn analyze(&mut self, samples: &[f32], sample_rate: u32) -> Result<TuningReading, String> {
        validate_input(samples, sample_rate)?;
        let raw = self
            .detector
            .estimate_samples(samples, sample_rate)
            .map_err(|error| error.to_string())?;

        if raw.frequency_hz.is_none() {
            self.reset_smoother()?;
            return Ok(TuningReading::listening(raw.confidence));
        }

        Ok(reading_from_estimate(self.smoother.smooth(raw)))
    }

    fn reset_smoother(&mut self) -> Result<(), String> {
        self.smoother = PitchSmoother::new(5).map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl Default for GuitarTuner {
    fn default() -> Self {
        Self::new().expect("guitar tuner defaults are valid")
    }
}

fn validate_input(samples: &[f32], sample_rate: u32) -> Result<(), String> {
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
        return Err(format!(
            "sample rate must be between {MIN_SAMPLE_RATE} and {MAX_SAMPLE_RATE} Hz"
        ));
    }
    if samples.len() > MAX_INPUT_SAMPLES {
        return Err(format!("audio window exceeds {MAX_INPUT_SAMPLES} samples"));
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err("audio samples must be finite".to_string());
    }
    Ok(())
}

fn reading_from_estimate(estimate: PitchEstimate) -> TuningReading {
    let Some(frequency_hz) = estimate.frequency_hz else {
        return TuningReading::listening(estimate.confidence);
    };
    let target = nearest_target(frequency_hz);
    let cents = cents_between(frequency_hz, target.frequency_hz);
    let status = if cents.abs() <= IN_TUNE_CENTS {
        TuningStatus::InTune
    } else if cents < 0.0 {
        TuningStatus::Flat
    } else {
        TuningStatus::Sharp
    };

    TuningReading {
        detected_frequency_hz: Some(frequency_hz),
        detected_note: estimate.note_name(),
        target_string: Some(target.name.to_string()),
        target_frequency_hz: Some(target.frequency_hz),
        cents: Some(cents),
        confidence: estimate.confidence,
        status,
    }
}

fn nearest_target(frequency_hz: f32) -> TargetString {
    STANDARD_TUNING
        .into_iter()
        .min_by(|left, right| {
            cents_between(frequency_hz, left.frequency_hz)
                .abs()
                .total_cmp(&cents_between(frequency_hz, right.frequency_hz).abs())
        })
        .expect("standard tuning is non-empty")
}

fn cents_between(frequency_hz: f32, target_frequency_hz: f32) -> f32 {
    1200.0 * (frequency_hz / target_frequency_hz).log2()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn harmonic_tone(
        fundamental_hz: f32,
        sample_rate: u32,
        seconds: f32,
        amplitudes: &[f32],
    ) -> Vec<f32> {
        let sample_count = (sample_rate as f32 * seconds) as usize;
        (0..sample_count)
            .map(|index| {
                let time = index as f32 / sample_rate as f32;
                amplitudes
                    .iter()
                    .enumerate()
                    .map(|(harmonic, amplitude)| {
                        let frequency = fundamental_hz * (harmonic + 1) as f32;
                        amplitude * (2.0 * std::f32::consts::PI * frequency * time).sin()
                    })
                    .sum()
            })
            .collect()
    }

    #[test]
    fn exact_standard_pitch_is_in_tune() {
        let reading = reading_from_estimate(PitchEstimate {
            frequency_hz: Some(110.0),
            confidence: 0.95,
        });
        assert_eq!(reading.target_string.as_deref(), Some("A2"));
        assert_eq!(reading.status, TuningStatus::InTune);
        assert!(reading.cents.unwrap().abs() < 0.01);
    }

    #[test]
    fn reports_flat_and_sharp_direction() {
        assert_eq!(
            reading_from_estimate(PitchEstimate {
                frequency_hz: Some(108.0),
                confidence: 0.9,
            })
            .status,
            TuningStatus::Flat
        );
        assert_eq!(
            reading_from_estimate(PitchEstimate {
                frequency_hz: Some(112.0),
                confidence: 0.9,
            })
            .status,
            TuningStatus::Sharp
        );
    }

    #[test]
    fn harmonic_rich_low_e_resolves_to_the_fundamental() {
        let mut tuner = GuitarTuner::default();
        let samples = harmonic_tone(82.4069, 48_000, 0.17, &[0.05, 1.0, 0.4, 0.2, 0.1]);
        let reading = tuner.analyze(&samples, 48_000).unwrap();

        assert_eq!(reading.target_string.as_deref(), Some("E2"));
        assert_eq!(reading.status, TuningStatus::InTune);
        assert!(reading.detected_frequency_hz.unwrap() < 90.0);
    }

    #[test]
    fn silence_returns_to_listening_and_clears_smoothing_history() {
        let mut tuner = GuitarTuner::default();
        let pitched = harmonic_tone(110.0, 48_000, 0.17, &[1.0, 0.3, 0.15]);
        assert!(tuner.analyze(&pitched, 48_000).unwrap().detected_frequency_hz.is_some());

        let silence = tuner.analyze(&vec![0.0; 8192], 48_000).unwrap();
        assert_eq!(silence.status, TuningStatus::Listening);
        assert_eq!(silence.detected_frequency_hz, None);
    }

    #[test]
    fn rejects_unbounded_or_invalid_input() {
        let mut tuner = GuitarTuner::default();
        assert!(tuner.analyze(&[0.0; 3], 0).is_err());
        assert!(tuner.analyze(&vec![0.0; MAX_INPUT_SAMPLES + 1], 48_000).is_err());
        assert!(tuner.analyze(&[f32::NAN], 48_000).is_err());
    }
}
