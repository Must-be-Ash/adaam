import {
  photonAppIconPngBase64,
  photonAppIconSvgSource,
} from "./photon-app-icon.generated";

export const PHOTON_APP_ICON_SVG_PATH = "logo.svg";
export const PHOTON_APP_ICON_PNG_PATH = "logo@4x.png";
export const PHOTON_APP_MANIFEST_PATH = "manifest.webmanifest";

export const PHOTON_APP_ICON_SVG = photonAppIconSvgSource;
export const PHOTON_APP_ICON_PNG = Uint8Array.from(
  Buffer.from(photonAppIconPngBase64, "base64"),
);

export function photonAppIconAssetPaths(basePath: string): {
  manifest: string;
  png: string;
  svg: string;
} {
  return {
    manifest: `${basePath}/${PHOTON_APP_MANIFEST_PATH}`,
    png: `${basePath}/${PHOTON_APP_ICON_PNG_PATH}`,
    svg: `${basePath}/${PHOTON_APP_ICON_SVG_PATH}`,
  };
}

export function photonAppIconHeadHtml(
  origin: string,
  basePath: string,
  options: {
    description: string;
    title: string;
  },
): string {
  const paths = photonAppIconAssetPaths(basePath);
  const iconUrl = new URL(paths.svg, origin).toString();
  const touchIconUrl = new URL(paths.png, origin).toString();
  const manifestUrl = new URL(paths.manifest, origin).toString();
  return `<meta name="apple-mobile-web-app-title" content="Eve">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Eve">
  <meta property="og:title" content="${options.title}">
  <meta property="og:description" content="${options.description}">
  <meta property="og:image" content="${touchIconUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="2906">
  <meta property="og:image:height" content="2906">
  <link rel="icon" type="image/svg+xml" sizes="any" href="${iconUrl}">
  <link rel="apple-touch-icon" href="${touchIconUrl}">
  <link rel="manifest" href="${manifestUrl}">`;
}

export function photonAppIconManifest(iconOrigin: string, basePath: string): string {
  const paths = photonAppIconAssetPaths(basePath);
  const svgIconUrl = new URL(paths.svg, iconOrigin).toString();
  const pngIconUrl = new URL(paths.png, iconOrigin).toString();
  return JSON.stringify({
    background_color: "#171717",
    display: "standalone",
    icons: [
      {
        purpose: "any maskable",
        sizes: "any",
        src: svgIconUrl,
        type: "image/svg+xml",
      },
      {
        purpose: "any maskable",
        sizes: "2906x2906",
        src: pngIconUrl,
        type: "image/png",
      },
    ],
    name: "Eve Sessions",
    short_name: "Eve",
    theme_color: "#171717",
  });
}
