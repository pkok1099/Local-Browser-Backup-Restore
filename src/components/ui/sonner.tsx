import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ theme = 'light', ...props }: ToasterProps) => {
  return (
    <div data-toaster-ready="" style={{ display: 'contents' }}>
      <Sonner
        theme={theme}
        className="toaster group"
        style={
          {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
          } as React.CSSProperties
        }
        {...props}
      />
    </div>
  );
};

export { Toaster };
