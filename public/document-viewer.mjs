export async function renderPdf(holder,url) {
  holder.textContent="Laster dokumentet …";
  let loadingTask, rendering, disposed=false;
  const cleanup=()=>{
    if (disposed) return;
    disposed=true;
    rendering?.cancel();
    // PDF.js 6 owns destruction on the loading task, not PDFDocumentProxy.
    return loadingTask?.destroy().catch(error=>console.warn("Kunne ikke frigjøre PDF-viseren",error));
  };
  holder.cleanup=cleanup;
  try {
    const pdfjs=await import("/pdfjs/build/pdf.mjs");
    if (disposed) return cleanup;
    pdfjs.GlobalWorkerOptions.workerSrc="/pdfjs/build/pdf.worker.mjs";
    loadingTask=pdfjs.getDocument({url,isEvalSupported:false,standardFontDataUrl:"/pdfjs/standard_fonts/",cMapUrl:"/pdfjs/cmaps/",cMapPacked:true,wasmUrl:"/pdfjs/wasm/"});
    const pdf=await loadingTask.promise;
    if (disposed) return cleanup;
    holder.replaceChildren();
    const controls=document.createElement("div"); controls.className="pdf-controls";
    const previous=document.createElement("button"); previous.textContent="← Forrige side";
    const count=document.createElement("span"); count.setAttribute("aria-live","polite");
    const next=document.createElement("button"); next.textContent="Neste side →";
    const canvas=document.createElement("canvas"); canvas.setAttribute("role","img");
    controls.append(previous,count,next); holder.append(controls,canvas);
    let number=1;
    async function render() {
      if (disposed) return;
      previous.disabled=true; next.disabled=true;
      count.textContent=`Side ${number} av ${pdf.numPages}`;
      const page=await pdf.getPage(number);
      if (disposed) return;
      const original=page.getViewport({scale:1});
      const scale=Math.min(Math.max(holder.clientWidth,300)/original.width,2);
      const ratio=Math.min(window.devicePixelRatio || 1,2);
      const viewport=page.getViewport({scale:scale*ratio});
      canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
      canvas.style.width=`${Math.ceil(viewport.width/ratio)}px`; canvas.style.height="auto";
      canvas.setAttribute("aria-label",`Dokument, side ${number} av ${pdf.numPages}`);
      rendering=page.render({canvasContext:canvas.getContext("2d"),viewport});
      await rendering.promise;
      previous.disabled=number===1; next.disabled=number===pdf.numPages;
    }
    previous.onclick=()=>{number--;render().catch(showError);};
    next.onclick=()=>{number++;render().catch(showError);};
    function showError(error) { if (!disposed) count.textContent=`Kunne ikke vise siden: ${error.message}. Bruk Last ned original.`; }
    await render();
    return cleanup;
  } catch(error) {
    if (!disposed) holder.textContent=`Kunne ikke vise PDF-en: ${error.message}. Bruk Last ned original.`;
    cleanup();
    return cleanup;
  }
}
