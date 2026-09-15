//! Adapters from iroh QUIC streams to WHATWG streams.

use std::{
    pin::Pin,
    task::{Context, Poll, ready},
};

use bytes::{Buf, Bytes};
use futures_util::{Sink, Stream};
use iroh::endpoint::{ReadError, RecvStream, SendStream};
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

use crate::error::{Code, js_error, read_error, write_error};

/// Largest chunk handed to JS per `read()`.
const READ_CHUNK: usize = 64 * 1024;

/// Returns a JS array `[WritableStream, ReadableStream]`.
pub fn bi_pair(send: SendStream, recv: RecvStream) -> JsValue {
    let arr = js_sys::Array::new();
    arr.push(&writable(send));
    arr.push(&readable(recv));
    arr.into()
}

/// Wraps a [`SendStream`] as a `WritableStream<Uint8Array>`.
///
/// `close()` flushes and finishes the QUIC stream; `abort()` drops it, which
/// resets the stream on the wire.
pub fn writable(send: SendStream) -> JsValue {
    wasm_streams::WritableStream::from_sink(SendSink {
        stream: send,
        pending: Bytes::new(),
    })
    .into_raw()
    .into()
}

/// Wraps a [`RecvStream`] as a `ReadableStream<Uint8Array>`.
///
/// The stream ends when the remote finishes; `cancel()` drops the QUIC stream,
/// which sends `STOP_SENDING` to the peer.
pub fn readable(recv: RecvStream) -> JsValue {
    wasm_streams::ReadableStream::from_stream(RecvSource::new(recv))
        .into_raw()
        .into()
}

struct SendSink {
    stream: SendStream,
    pending: Bytes,
}

impl Sink<JsValue> for SendSink {
    type Error = JsValue;

    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), JsValue>> {
        self.poll_flush(cx)
    }

    fn start_send(mut self: Pin<&mut Self>, item: JsValue) -> Result<(), JsValue> {
        let chunk = item
            .dyn_into::<Uint8Array>()
            .map_err(|_| js_error(Code::InvalidArgument, "chunk must be a Uint8Array"))?;
        self.pending = Bytes::from(chunk.to_vec());
        Ok(())
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), JsValue>> {
        let this = &mut *self;
        while !this.pending.is_empty() {
            let n = ready!(Pin::new(&mut this.stream).poll_write(cx, &this.pending))
                .map_err(write_error)?;
            this.pending.advance(n);
        }
        Poll::Ready(Ok(()))
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), JsValue>> {
        ready!(self.as_mut().poll_flush(cx))?;
        self.stream
            .finish()
            .map_err(|e| js_error(Code::StreamClosed, format!("{e}")))?;
        Poll::Ready(Ok(()))
    }
}

type ReadFuture = Pin<Box<dyn Future<Output = (RecvStream, Result<Option<Bytes>, ReadError>)>>>;

enum RecvSource {
    Idle(RecvStream),
    Reading(ReadFuture),
    Done,
}

impl RecvSource {
    fn new(recv: RecvStream) -> Self {
        RecvSource::Idle(recv)
    }
}

impl Stream for RecvSource {
    type Item = Result<JsValue, JsValue>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match std::mem::replace(&mut *self, RecvSource::Done) {
                RecvSource::Idle(mut recv) => {
                    *self = RecvSource::Reading(Box::pin(async move {
                        let res = recv.read_chunk(READ_CHUNK).await;
                        (recv, res)
                    }));
                }
                RecvSource::Reading(mut fut) => match fut.as_mut().poll(cx) {
                    Poll::Pending => {
                        *self = RecvSource::Reading(fut);
                        return Poll::Pending;
                    }
                    Poll::Ready((recv, Ok(Some(bytes)))) => {
                        *self = RecvSource::Idle(recv);
                        return Poll::Ready(Some(Ok(Uint8Array::from(&bytes[..]).into())));
                    }
                    Poll::Ready((_, Ok(None))) => return Poll::Ready(None),
                    Poll::Ready((_, Err(e))) => return Poll::Ready(Some(Err(read_error(e)))),
                },
                RecvSource::Done => return Poll::Ready(None),
            }
        }
    }
}
