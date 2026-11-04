"""Convert every image frame to a readable PNG without changing the original."""
import json
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.runtime' / 'phone-images'))
from PIL import Image, ImageOps
import pillow_heif

pillow_heif.register_heif_opener()
Image.MAX_IMAGE_PIXELS = 80_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
source, target = map(Path, sys.argv[1:3])
target.parent.mkdir(parents=True, exist_ok=True)
pages = []
with Image.open(source) as original:
    count = getattr(original, 'n_frames', 1)
    if count > 40:
        raise ValueError('Mer enn 40 bilder i filen; må deles opp og kontrolleres.')
    for index in range(count):
        original.seek(index)
        image = ImageOps.exif_transpose(original).convert('RGB')
        output = target.with_name(f'{target.stem}-{index + 1}.png')
        image.save(output, 'PNG')
        pages.append(str(output.resolve()))
print(json.dumps({'original': str(source.resolve()), 'pageCount': len(pages), 'pages': pages}))
