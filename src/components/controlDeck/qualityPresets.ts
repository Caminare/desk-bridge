export type StreamQualityPreset = 'sd' | 'hd' | 'ultra';

export const QUALITY_PRESETS: Record<StreamQualityPreset, { label: string; maxWidth: number; jpegQuality: number }> = {
  sd: { label: 'SD', maxWidth: 854, jpegQuality: 52 },
  hd: { label: 'HD', maxWidth: 1152, jpegQuality: 62 },
  ultra: { label: 'Ultra', maxWidth: 1600, jpegQuality: 78 },
};

export const QUALITY_OPTIONS = Object.entries(QUALITY_PRESETS) as Array<
  [StreamQualityPreset, (typeof QUALITY_PRESETS)[StreamQualityPreset]]
>;
