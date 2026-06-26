export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Travel Money API</h1>
      <p>LINE group expense splitting service.</p>
      <ul>
        <li>POST /api/webhook — LINE Bot webhook</li>
        <li>GET /api/trips?groupId=xxx</li>
        <li>GET /api/trips/:tripId/expenses</li>
        <li>GET /api/trips/:tripId/settle</li>
      </ul>
    </main>
  )
}
