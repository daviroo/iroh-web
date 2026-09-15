//! Conversion of iroh errors into JS `Error` objects with a stable `code`.

use iroh::endpoint::{
    BindError, ConnectError, ConnectWithOptsError, ConnectingError, ConnectionError, ReadError,
    WriteError,
};
use wasm_bindgen::prelude::*;

/// Stable error codes exposed on the JS `Error.code` property.
#[derive(Debug, Clone, Copy)]
pub enum Code {
    InvalidArgument,
    Internal,
    BindFailed,
    EndpointClosed,
    SelfConnect,
    NoAddress,
    ConnectFailed,
    HandshakeFailed,
    Rejected,
    ApplicationClosed,
    ConnectionClosed,
    TimedOut,
    LocallyClosed,
    Reset,
    TransportError,
    StreamStopped,
    StreamReset,
    StreamClosed,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidArgument => "invalid_argument",
            Code::Internal => "internal",
            Code::BindFailed => "bind_failed",
            Code::EndpointClosed => "endpoint_closed",
            Code::SelfConnect => "self_connect",
            Code::NoAddress => "no_address",
            Code::ConnectFailed => "connect_failed",
            Code::HandshakeFailed => "handshake_failed",
            Code::Rejected => "rejected",
            Code::ApplicationClosed => "application_closed",
            Code::ConnectionClosed => "connection_closed",
            Code::TimedOut => "timed_out",
            Code::LocallyClosed => "locally_closed",
            Code::Reset => "reset",
            Code::TransportError => "transport_error",
            Code::StreamStopped => "stream_stopped",
            Code::StreamReset => "stream_reset",
            Code::StreamClosed => "stream_closed",
        }
    }
}

/// Creates a JS `Error` with `name = "IrohError"` and a string `code` property.
pub fn js_error(code: Code, message: impl AsRef<str>) -> JsValue {
    let err = js_sys::Error::new(message.as_ref());
    err.set_name("IrohError");
    let _ = js_sys::Reflect::set(&err, &"code".into(), &code.as_str().into());
    err.into()
}

fn with_app_close(err: JsValue, error_code: u64, reason: &[u8]) -> JsValue {
    let _ = js_sys::Reflect::set(&err, &"errorCode".into(), &JsValue::from_f64(error_code as f64));
    let _ = js_sys::Reflect::set(
        &err,
        &"reason".into(),
        &String::from_utf8_lossy(reason).as_ref().into(),
    );
    err
}

pub fn bind_error(e: BindError) -> JsValue {
    js_error(Code::BindFailed, format!("failed to bind endpoint: {e:#}"))
}

pub fn connection_error(e: &ConnectionError) -> JsValue {
    match e {
        ConnectionError::ApplicationClosed(close) => with_app_close(
            js_error(Code::ApplicationClosed, format!("{e}")),
            close.error_code.into_inner(),
            &close.reason,
        ),
        ConnectionError::ConnectionClosed(_) => js_error(Code::ConnectionClosed, format!("{e}")),
        ConnectionError::TimedOut => js_error(Code::TimedOut, format!("{e}")),
        ConnectionError::LocallyClosed => js_error(Code::LocallyClosed, format!("{e}")),
        ConnectionError::Reset => js_error(Code::Reset, format!("{e}")),
        _ => js_error(Code::TransportError, format!("{e}")),
    }
}

pub fn connect_error(e: ConnectError) -> JsValue {
    match e {
        ConnectError::Connect { source, .. } => match source {
            ConnectWithOptsError::SelfConnect { .. } => {
                js_error(Code::SelfConnect, format!("{source:#}"))
            }
            ConnectWithOptsError::NoAddress { .. } => {
                js_error(Code::NoAddress, format!("{source:#}"))
            }
            ConnectWithOptsError::EndpointClosed { .. } => {
                js_error(Code::EndpointClosed, format!("{source:#}"))
            }
            ConnectWithOptsError::InvalidAlpn { .. } => {
                js_error(Code::InvalidArgument, format!("{source:#}"))
            }
            ConnectWithOptsError::LocallyRejected { .. } => {
                js_error(Code::Rejected, format!("{source:#}"))
            }
            _ => js_error(Code::ConnectFailed, format!("{source:#}")),
        },
        ConnectError::Connecting { source, .. } => match source {
            ConnectingError::ConnectionError { source, .. } => connection_error(&source),
            ConnectingError::HandshakeFailure { .. } => {
                js_error(Code::HandshakeFailed, format!("{source:#}"))
            }
            ConnectingError::LocallyRejected { .. } => {
                js_error(Code::Rejected, format!("{source:#}"))
            }
            _ => js_error(Code::ConnectFailed, format!("{source:#}")),
        },
        ConnectError::Connection { source, .. } => connection_error(&source),
        _ => js_error(Code::ConnectFailed, format!("{e:#}")),
    }
}

pub fn write_error(e: WriteError) -> JsValue {
    match e {
        WriteError::Stopped(code) => with_app_close(
            js_error(Code::StreamStopped, format!("{e}")),
            code.into_inner(),
            b"",
        ),
        WriteError::ConnectionLost(ref inner) => connection_error(inner),
        WriteError::ClosedStream => js_error(Code::StreamClosed, format!("{e}")),
        _ => js_error(Code::TransportError, format!("{e}")),
    }
}

pub fn read_error(e: ReadError) -> JsValue {
    match e {
        ReadError::Reset(code) => with_app_close(
            js_error(Code::StreamReset, format!("{e}")),
            code.into_inner(),
            b"",
        ),
        ReadError::ConnectionLost(ref inner) => connection_error(inner),
        ReadError::ClosedStream => js_error(Code::StreamClosed, format!("{e}")),
        _ => js_error(Code::TransportError, format!("{e}")),
    }
}
