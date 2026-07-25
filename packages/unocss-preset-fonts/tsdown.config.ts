import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    './src/index.ts',
  ],
  noExternal: [
    '@proj-vera/font-cjkfonts-allseto',
    '@proj-vera/font-departure-mono',
    '@proj-vera/font-xiaolai',
  ],
  dts: true,
  sourcemap: true,
})
