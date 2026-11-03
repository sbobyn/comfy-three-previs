// Finished starters open with cast images, stills, videos and a cut. Blockout starters (2026-11-02) open with their blockout
// clips and written Cast Cards; their images and videos are the user's to make (examples/starters/README.md).
export const FINISHED_STARTERS = ['breaking-news', 'wingspan', 'final-lap', 'posterized'];
export const BLOCKOUT_STARTERS = ['mountain-trail', 'city-blocks', 'camera-moves', 'look-lab', 'two-hander'];
// Look Lab (paid hybrid, 2026-11-02; v2 the same day) also ships one start still per variant (GPT Image 2.5, except the
// stronger anime and claymation from Nano Banana 2.1) and an edit video for these twelve (Seedance 2.5 for v1's four and
// v2's heavy rain, Kling O1 for v2's other seven); every other blockout starter ships no stills or videos.
export const LOOK_LAB_VIDEOS = ['Night', 'Winter', 'Anime', 'Claymation', 'Golden hour', 'Blue hour', 'Heavy rain', 'Snowstorm',
  'Dog walker', 'Couple', 'Wardrobe · cyberpunk', 'Claymation (stronger)'].sort();
export const LOOK_LAB_STILL_MODELS = { 'Anime (stronger)': 'nano-banana-2-1', 'Claymation (stronger)': 'nano-banana-2-1' };
