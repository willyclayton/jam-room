import Room from "@/components/Room";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roomId = id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "JAM";
  return <Room id={roomId} />;
}
