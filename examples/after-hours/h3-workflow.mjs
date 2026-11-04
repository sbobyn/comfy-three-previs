// Original API graph, checked against live Cloud schema before use. No dispatch here.
export const afterHoursH3 = {
  version: 1, id: 'after-hours-h3-reference-v1', title: 'MiniMax H3 · full camera clip + Comfy wardrobe', task: 'transform-video',
  description: 'Reference-to-video: the complete camera clip is Video 1. Three original appearance boards are Image 1–3. Motion transfer must be judged in the result, not assumed. Cloud native 768P output can differ from the 720p source.',
  graph: {
    '1': { class_type: 'LoadVideo', inputs: { file: 'previs-source.mp4' } },
    '2': { class_type: 'MinimaxHailuo03ReferenceNode', inputs: { model: 'MiniMax H3', 'model.prompt': '', 'model.resolution': '768P', 'model.ratio': '16:9', 'model.duration': 4, 'model.reference_videos.video_1': ['1', 0], 'model.reference_images.image_1': ['11', 0], 'model.reference_images.image_2': ['12', 0], 'model.reference_images.image_3': ['13', 0], seed: 4242, watermark: false } },
    '3': { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: 'previs/after-hours-h3', format: 'mp4', 'format.codec': 'h264' } },
    '11': { class_type: 'LoadImage', inputs: { image: 'previs-appearance-1.png' } },
    '12': { class_type: 'LoadImage', inputs: { image: 'previs-appearance-2.png' } },
    '13': { class_type: 'LoadImage', inputs: { image: 'previs-appearance-3.png' } },
  },
  inputs: { sourceVideo: { nodeId: '1', input: 'file' }, prompt: { nodeId: '2', input: 'model.prompt' }, referenceImage1: { nodeId: '11', input: 'image' }, referenceImage2: { nodeId: '12', input: 'image' }, referenceImage3: { nodeId: '13', input: 'image' } },
  parameters: { duration: { nodeId: '2', input: 'model.duration' }, resolution: { nodeId: '2', input: 'model.resolution' }, aspectRatio: { nodeId: '2', input: 'model.ratio' }, seed: { nodeId: '2', input: 'seed' }, watermark: { nodeId: '2', input: 'watermark' } },
  outputs: [{ nodeId: '3', mediaType: 'video/mp4' }],
  constraints: { sourceVideo: { width: { min: 1280 }, height: { min: 720 }, fps: { min: 24, max: 24 }, duration: { min: 4, max: 4 }, frameCount: { min: 96, max: 96 } }, promptMaxLength: 10000, timingChange: 'Source is 1280×720, 96 frames at 24 fps, 4 seconds. H3 is requested at native 768P / 16:9 / 4 seconds; returned dimensions, timing, audio and motion must be inspected. No resize or timing fit is authorized.' },
  backendRequirements: { kinds: ['cloud'] }, pricing: { status: 'unknown', source: 'Live Cloud MinimaxHailuo03ReferenceNode price_badge', partnerEstimate: { currency: 'USD', min: .7722, max: 2.4453, note: 'Published badge range at 768P, output 4 seconds, one reference video, three images. Runtime/account charges may be additional. Estimate is not a settled bill or provider-enforced spending cap.' } },
  provenance: { author: 'Original Previs demo graph', source: 'https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_minimax.py', conditioning: 'full-video-reference-and-appearance-images' }, verification: { status: 'imported' },
};
