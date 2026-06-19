from astropy.io import fits
import matplotlib.pyplot as plt
import numpy as np

hdul = fits.open("imagen.fits")
datos = hdul[1].data

datos = np.clip(datos, 0, None)
imagen = np.log(datos + 1)

plt.imshow(imagen, cmap='inferno')
plt.colorbar()

plt.savefig("resultado.png", dpi=300, bbox_inches='tight')
plt.close()

print("Imagen creada: resultado.png")
