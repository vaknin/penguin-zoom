/* GStreamer tracer "penguincamfix": works around two WebKitGTK camera bugs.
 *
 * 1. Frozen camera.
 * WebKitGTK (seen in 2.54.1, with GStreamer 1.28 or newer) runs its camera
 * pipeline with base time 0, so the first camera buffer's timestamp is the
 * time since boot. Its `videorate` element counts from 0 and first emits one
 * duplicate of that frame for every 1/30 s since boot: the camera is frozen
 * for minutes after it starts and the web process burns a core or two.
 * WebKit's main branch fixes it by setting skip-to-first=TRUE on videorate
 * (GStreamerVideoCapturer.cpp). This tracer does the same from outside: it is
 * loaded into WebKit's web process through GST_PLUGIN_PATH + GST_TRACERS
 * (src/main.rs) and sets the property on every videorate as it is created.
 * Harmless once WebKit sets it itself; delete it then (PLAN.md §5.9).
 *
 * 2. Half the frame rate. The pipeline behind a <video> that plays a camera
 * ends in WebKit's "webkit-gl-video-appsink". WebKit turns QoS on for it by
 * mistake (it means to skip camera players, PLAN.md §5.11). Camera buffers
 * carry a decode timestamp later than their presentation timestamp by the
 * capture latency (about 53 ms); the sink's QoS events use the first, the
 * converters before it compare the second and skip the next frame, every
 * time: 15 frames a second out of 30. The tracer turns that sink's QoS off
 * when it starts. Fix proposed upstream: WebKit/WebKit pull request 81251.
 */
#define GST_USE_UNSTABLE_API
#include <gst/gst.h>
#include <gst/gsttracer.h>

#define PACKAGE "penguin-zoom"

typedef struct { GstTracer parent; } CamFix;
typedef struct { GstTracerClass parent_class; } CamFixClass;
G_DEFINE_TYPE(CamFix, cam_fix, GST_TYPE_TRACER)

static void on_element_new(GObject *tracer, GstClockTime ts, GstElement *e) {
    GstElementFactory *f = gst_element_get_factory(e);
    if (f && g_strcmp0(GST_OBJECT_NAME(f), "videorate") == 0
          && g_object_class_find_property(G_OBJECT_GET_CLASS(e), "skip-to-first"))
        g_object_set(e, "skip-to-first", TRUE, NULL);
}

static void on_state_change(GObject *tracer, GstClockTime ts, GstElement *e, GstStateChange change) {
    if (change != GST_STATE_CHANGE_NULL_TO_READY) return;
    GstElementFactory *f = gst_element_get_factory(e);
    if (f && g_strcmp0(GST_OBJECT_NAME(f), "appsink") == 0
          && g_str_has_prefix(GST_OBJECT_NAME(e), "webkit-gl-video-appsink"))
        g_object_set(e, "qos", FALSE, NULL);
}

static void cam_fix_class_init(CamFixClass *klass) {}
static void cam_fix_init(CamFix *self) {
    gst_tracing_register_hook(GST_TRACER(self), "element-new", G_CALLBACK(on_element_new));
    gst_tracing_register_hook(GST_TRACER(self), "element-change-state-pre", G_CALLBACK(on_state_change));
}

static gboolean plugin_init(GstPlugin *plugin) {
    return gst_tracer_register(plugin, "penguincamfix", cam_fix_get_type());
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, penguincamfix,
    "Penguin for Zoom: WebKitGTK camera capture workaround", plugin_init,
    "0.1.0", "LGPL", "penguin-zoom", "https://github.com/")
