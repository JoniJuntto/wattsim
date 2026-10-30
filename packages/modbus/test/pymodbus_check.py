"""Reads the emulated meters with pymodbus, an independent Modbus TCP client. Prints JSON.

Usage: python pymodbus_check.py <port>
Unit 1 is an SDM630, unit 2 an EM24, unit 3 the generic map (see interop.test.ts).
"""
import inspect
import json
import struct
import sys

import pymodbus
from pymodbus.client import ModbusTcpClient

port = int(sys.argv[1])
client = ModbusTcpClient("127.0.0.1", port=port, timeout=2)
assert client.connect(), "connect failed"

# pymodbus renamed the unit keyword from `slave` to `device_id` in 3.9.
UNIT = "device_id" if "device_id" in inspect.signature(client.read_input_registers).parameters else "slave"


def call(fn, *args, unit, **kw):
    kw[UNIT] = unit
    return fn(*args, **kw)


def regs(rr):
    assert not rr.isError(), rr
    return list(rr.registers)


def f32_msw(r):
    return struct.unpack(">f", struct.pack(">HH", r[0], r[1]))[0]


def i32_lsw(r):
    return struct.unpack(">i", struct.pack(">HH", r[1], r[0]))[0]


out = {"pymodbus": pymodbus.__version__}

sdm = regs(call(client.read_input_registers, 0, count=80, unit=1))
out["sdm630"] = {
    "voltageL1": f32_msw(sdm[0:2]),
    "currentL1": f32_msw(sdm[6:8]),
    "currentL2": f32_msw(sdm[8:10]),
    "powerTotal": f32_msw(sdm[0x34:0x36]),
    "frequency": f32_msw(sdm[0x46:0x48]),
    "importKwh": f32_msw(sdm[0x48:0x4A]),
    "demandPeriod": f32_msw(regs(call(client.read_holding_registers, 2, count=2, unit=1))),
}
call(client.write_registers, 2, [0x4170, 0x0000], unit=1)  # demand period 15
out["sdm630"]["demandPeriodAfterWrite"] = f32_msw(regs(call(client.read_holding_registers, 2, count=2, unit=1)))
out["sdm630"]["fc06Exception"] = call(client.write_register, 2, 1, unit=1).exception_code
out["sdm630"]["splitFloatException"] = call(client.read_input_registers, 1, count=2, unit=1).exception_code

em = regs(call(client.read_input_registers, 0, count=0x52, unit=2))
out["em24"] = {
    "voltageL1": i32_lsw(em[0:2]) / 10,
    "currentL1": i32_lsw(em[0x0C:0x0E]) / 1000,
    "powerL2": i32_lsw(em[0x14:0x16]) / 10,
    "importKwh": i32_lsw(em[0x34:0x36]) / 10,
    "frequency": em[0x33] / 10,
    "idCode": regs(call(client.read_holding_registers, 0x0B, count=1, unit=2))[0],
}
call(client.write_register, 0x1201, 0x5A02, unit=2)
out["em24"]["tariff"] = regs(call(client.read_holding_registers, 0x1201, count=1, unit=2))[0]

call(client.write_registers, 0x102, [0x4370, 0x8000], unit=3)
call(client.write_register, 0x100, 0x1234, unit=3)
g = regs(call(client.read_holding_registers, 0x100, count=4, unit=3))
out["generic"] = {
    "userRegister": g[0],
    "userFloat": f32_msw(g[2:4]),
    "breakerRatingA": f32_msw(regs(call(client.read_input_registers, 0x4C, count=2, unit=3))),
}
out["unknownUnitException"] = call(client.read_input_registers, 0, count=2, unit=99).exception_code

client.close()
print(json.dumps(out))
