"""Contact sheets at every 24 fps frame, plus overview strips, from app-captured MP4s."""
import json, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw
root=Path(sys.argv[1])
for stage in ([sys.argv[2]] if len(sys.argv)>2 else ['before','after']):
 folder=root/stage
 if not (folder/'captures.json').exists(): continue
 for item in json.loads((folder/'captures.json').read_text()):
  stem=Path(item['file']).stem
  if len(sys.argv)>3 and sys.argv[3] not in stem: continue
  frames=folder/(stem+'-frames'); frames.mkdir(exist_ok=True)
  subprocess.run(['ffmpeg','-v','error','-y','-i',str(folder/item['file']),'-vsync','0',str(frames/'%03d.png')],check=True)
  files=sorted(frames.glob('*.png')); w,h=256,144
  for page in range((len(files)+23)//24):
   sheet=Image.new('RGB',(w*4,(h+22)*6+34),'#161a22');draw=ImageDraw.Draw(sheet)
   draw.text((8,8),f"{stage} / {item['title']} / frames {page*24}–{min(len(files)-1,page*24+23)}",fill='white')
   for i,f in enumerate(files[page*24:page*24+24]):
    x=(i%4)*w;y=(i//4)*(h+22)+34
    sheet.paste(Image.open(f).resize((w,h)),(x,y));draw.text((x+5,y+h+3),f'{page*24+i:03d}  {(page*24+i)/24:.3f}s',fill='white')
   sheet.save(folder/f'{stem}-frames-{page+1}.jpg',quality=88)
  sheet=Image.new('RGB',(320*4,202*2+32),'#161a22');draw=ImageDraw.Draw(sheet)
  draw.text((8,8),f"{stage} / {item['title']} / {len(files)} frames at 24 fps",fill='white')
  for i in range(8):
   frame=round(i*(len(files)-1)/7); x=i%4*320;y=i//4*202+32
   sheet.paste(Image.open(files[frame]).resize((320,180)),(x,y));draw.text((x+5,y+182),f'{frame/24:.3f}s',fill='white')
  sheet.save(folder/f'{stem}-sheet.jpg',quality=92)
