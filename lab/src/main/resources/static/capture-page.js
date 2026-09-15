import {mountCaptureComposer} from './capture-composer.js';
const params=new URLSearchParams(location.search);
window.captureComposer=await mountCaptureComposer(document.getElementById('capture'),{apiBase:new URL('api/captures',location.href).href,photoId:params.get('photo')});
