/**
 * Catálogo do lote video-display (Vídeo, YouTube e anúncios de Display): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * upload_youtube_video fica em write (não em chained): em validateOnly/dry-run ela valida os
 * dados localmente e devolve sem enviar nada, o que é mais útil do que a recusa genérica.
 */
export const catalog = {
  read: [
    "get_video_performance",
    "get_youtube_video_uploads",
    "list_youtube_video_links",
  ] as string[],
  write: [
    "upload_youtube_video",
    "remove_youtube_video_upload",
    "create_image_ad",
    "request_youtube_video_link",
    "respond_youtube_video_link",
  ] as string[],
  chained: [] as string[],
};
