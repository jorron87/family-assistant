"""SSH diagnostics for the user's dashboard: X11 pointer input, no browser data."""
import ctypes
import os
import sys
import time

os.environ.setdefault("DISPLAY", ":0")
os.environ.setdefault("XAUTHORITY", os.path.expanduser("~/.Xauthority"))
x11 = ctypes.CDLL("libX11.so.6")
xtest = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtest.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtest.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit("Could not connect to dashboard X11 display")

def move(x, y):
    xtest.XTestFakeMotionEvent(display, -1, x, y, 0)
    x11.XFlush(display)

def button(number, down):
    xtest.XTestFakeButtonEvent(display, number, int(down), 0)
    x11.XFlush(display)

mode, *numbers = sys.argv[1:]
numbers = list(map(int, numbers))
if mode == "click":
    move(*numbers)
    button(1, True)
    time.sleep(.07)
    button(1, False)
elif mode == "drag":
    x, y, end_x, end_y = numbers
    move(x, y)
    button(1, True)
    for step in range(1, 21):
        move(round(x + (end_x-x)*step/20), round(y + (end_y-y)*step/20))
        time.sleep(.015)
    button(1, False)
elif mode == "scroll":
    x, y, ticks = numbers
    move(x, y)
    for _ in range(abs(ticks)):
        button(5 if ticks > 0 else 4, True)
        button(5 if ticks > 0 else 4, False)
        time.sleep(.03)
else:
    raise SystemExit("Use click x y, drag x y end_x end_y, or scroll x y ticks")
x11.XCloseDisplay(display)
