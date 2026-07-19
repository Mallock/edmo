/**
 * Catalog of known Piper voices (official rhasspy/piper-voices repository).
 * Two ship inside the installer; the rest are one-click downloads into the
 * app-data dir — fetched once from huggingface.co on the user's explicit
 * request, then used fully offline forever.
 */

export interface PiperVoiceInfo {
  name: string; // file stem, e.g. "en_US-lessac-medium"
  label: string;
  repoPath: string; // path in the repo without extension
  sizeMb: number;
  bundled?: boolean;
}

export const PIPER_VOICE_CATALOG: PiperVoiceInfo[] = [
  {
    name: 'en_GB-alba-medium',
    label: 'Alba — Scottish English, female',
    repoPath: 'en/en_GB/alba/medium/en_GB-alba-medium',
    sizeMb: 63,
    bundled: true,
  },
  {
    name: 'en_GB-northern_english_male-medium',
    label: 'Northern English, male',
    repoPath: 'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium',
    sizeMb: 63,
    bundled: true,
  },
  {
    name: 'en_US-lessac-medium',
    label: 'Lessac — US English, female',
    repoPath: 'en/en_US/lessac/medium/en_US-lessac-medium',
    sizeMb: 63,
  },
  {
    name: 'en_US-amy-medium',
    label: 'Amy — US English, female',
    repoPath: 'en/en_US/amy/medium/en_US-amy-medium',
    sizeMb: 63,
  },
  {
    name: 'en_US-joe-medium',
    label: 'Joe — US English, male',
    repoPath: 'en/en_US/joe/medium/en_US-joe-medium',
    sizeMb: 63,
  },
  {
    name: 'en_US-ryan-high',
    label: 'Ryan — US English, male (high quality)',
    repoPath: 'en/en_US/ryan/high/en_US-ryan-high',
    sizeMb: 115,
  },
  {
    name: 'en_GB-cori-high',
    label: 'Cori — British English, female (high quality)',
    repoPath: 'en/en_GB/cori/high/en_GB-cori-high',
    sizeMb: 108,
  },
  {
    name: 'en_GB-jenny_dioco-medium',
    label: 'Jenny — British English, female',
    repoPath: 'en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium',
    sizeMb: 63,
  },
];
