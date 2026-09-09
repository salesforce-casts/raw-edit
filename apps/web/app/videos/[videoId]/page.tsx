import { ReviewEditor } from "@/components/review-editor";

export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  return <ReviewEditor videoId={videoId} />;
}
