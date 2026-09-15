export const metadata = {
  title: 'Meme Coin Scanner',
  description: 'Live control panel for the Solana + BSC meme coin scanner',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#000000', color: '#f5f5f5', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
