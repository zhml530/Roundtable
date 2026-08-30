const screenshotNames = [
  'hero',
  'model-picker',
  'approval-card',
  'context-menu',
  'app-settings',
  'docs-onboarding',
  'docs-engine-detection',
  'docs-fresh-bot',
  'docs-model-picker',
  'docs-automations',
] as const;

type ScreenshotName = (typeof screenshotNames)[number];

export function ProductScreenshot({
  name,
  alt,
  caption,
  position = 'center',
}: {
  name: ScreenshotName;
  alt: string;
  caption?: string;
  position?: 'center' | 'top';
}) {
  return (
    <figure className="omb-product-shot">
      <div className="omb-product-shot-frame">
        <img
          src={`/screenshots/${name}.png`}
          alt={alt}
          loading="lazy"
          className={position === 'top' ? 'object-top' : 'object-center'}
        />
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
