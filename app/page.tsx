import StartButton from "@/components/StartButton";

export default function Home() {
  return (
    <main className="screen center">
      <div style={{ fontSize: 64 }} aria-hidden>
        🎸🥁
      </div>
      <h1 className="title">Jam Room</h1>
      <p className="lede">
        Start a room, send the link to a friend’s phone. One of you plays guitar, the other phone is the drummer, and
        it follows your tempo.
      </p>
      <div style={{ height: 8 }} />
      <StartButton />
    </main>
  );
}
