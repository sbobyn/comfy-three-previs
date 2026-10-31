"""Pair before/after app captures. Requires Pillow; accepts the evidence directory."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path(sys.argv[1])
entries=json.loads((root/'before/captures.json').read_text())
font=ImageFont.load_default(size=18)
small=ImageFont.load_default(size=14)
def sheet(items, file, width=480):
    h=round(width*9/16); row=h+34
    canvas=Image.new('RGB',(width*2+48,64+row*len(items)), '#111922')
    draw=ImageDraw.Draw(canvas)
    draw.text((16,14),'BEFORE  /  primitive blockouts',fill='#ccd5df',font=font)
    draw.text((width+32,14),'AFTER  /  Blender low-poly meshes',fill='#f2c661',font=font)
    for i,e in enumerate(items):
        y=52+i*row
        for j,stage in enumerate(('before','after')):
            im=Image.open(root/stage/e['file']).convert('RGB').resize((width,h),Image.Resampling.LANCZOS)
            canvas.paste(im,(16+j*(width+16),y+24))
        label=f"{e['slug']}  /  {e['shot']}  /  {e['moment']}  {e['t']:.2f}s"
        draw.text((16,y+3),label,fill='#e4e9ee',font=small)
    canvas.save(root/file)
sheet([e for e in entries if e['moment']=='mid'],'contact-sheet.png')
for slug in dict.fromkeys(e['slug'] for e in entries):
    sheet([e for e in entries if e['slug']==slug],f'{slug}-contact-sheet.png')
print(root/'contact-sheet.png')
