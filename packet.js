// Copyright 2011 Timothy J Fontaine <tjfontaine@gmail.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE

'use strict';

var consts = require('./consts'),
    BufferCursor = require('buffercursor'),
    BufferCursorOverflow = BufferCursor.BufferCursorOverflow,
    ipaddr = require('ipaddr.js'),
    assert = require('assert'),
    util = require('util');

function assertUndefined(val, msg) {
  assert(typeof val != 'undefined', msg);
}

var Packet = module.exports = function() {
  this.header = {
    id: 0,
    qr: 0,
    opcode: 0,
    aa: 0,
    tc: 0,
    rd: 1,
    ra: 0,
    res1: 0,
    res2: 0,
    res3: 0,
    rcode: 0
  };
  this.question = [];
  this.answer = [];
  this.authority = [];
  this.additional = [];
  this.edns_options = [];
  this.payload = undefined;
};

var LABEL_POINTER = 0xC0;

var isPointer = function(len) {
  return (len & LABEL_POINTER) === LABEL_POINTER;
};

var nameUnpack = function(buff) {
  var len, comp, end, pos, part, combine = '';

  len = buff.readUInt8();
  comp = false;

  while (len !== 0) {
    if (isPointer(len)) {
      len -= LABEL_POINTER;
      len = len << 8;
      pos = len + buff.readUInt8();
      if (!end)
        end = buff.tell();
      buff.seek(pos);
      len = buff.readUInt8();
      comp = true;
      continue;
    }

    part = buff.toString('ascii', len);

    if (combine.length)
      combine = combine + '.' + part;
    else
      combine = part;

    len = buff.readUInt8();

    if (!comp)
      end = buff.tell();
  }

  buff.seek(end);

  return combine;
};

var name_pack = function(str, buff, index) {
  var offset, dot, part;

  while (str) {
    if (index[str]) {
      offset = (LABEL_POINTER << 8) + index[str];
      buff.writeUInt16BE(offset);
      break;
    } else {
      index[str] = buff.tell();
      dot = str.indexOf('.');
      if (dot > -1) {
        part = str.slice(0, dot);
        str = str.slice(dot + 1);
      } else {
        part = str;
        str = undefined;
      }
      buff.writeUInt8(part.length);
      buff.write(part, part.length, 'ascii');
    }
  }

  if (!str) {
    buff.writeUInt8(0);
  }
};

Packet.write = function(buff, packet) {
  var state,
      next,
      name,
      val,
      section,
      count,
      pos,
      rdata_pos,
      last_resource,
      label_index = {};

  buff = BufferCursor(buff);

  if (typeof(packet.edns_version) !== 'undefined') {
    state = 'EDNS';
  } else {
    state = 'HEADER';
  }

  while (true) {
    try {
      switch (state) {
        case 'EDNS':
          val = {
            name: '',
            type: consts.NAME_TO_QTYPE.OPT,
            class: packet.payload
          };
          pos = packet.header.rcode;
          val.ttl = packet.header.rcode >> 4;
          packet.header.rcode = pos - (val.ttl << 4);
          val.ttl = (val.ttl << 8) + packet.edns_version;
          val.ttl = (val.ttl << 16) + (packet.do << 15) & 0x8000;
          packet.additional.splice(0, 0, val);
          state = 'HEADER';
          break;
        case 'HEADER':
          assert(packet.header, 'Packet requires "header"');
          buff.writeUInt16BE(packet.header.id & 0xFFFF);
          val = 0;
          val += (packet.header.qr << 15) & 0x8000;
          val += (packet.header.opcode << 11) & 0x7800;
          val += (packet.header.aa << 10) & 0x400;
          val += (packet.header.tc << 9) & 0x200;
          val += (packet.header.rd << 8) & 0x100;
          val += (packet.header.ra << 7) & 0x80;
          val += (packet.header.res1 << 6) & 0x40;
          val += (packet.header.res1 << 5) & 0x20;
          val += (packet.header.res1 << 4) & 0x10;
          val += packet.header.rcode & 0xF;
          buff.writeUInt16BE(val & 0xFFFF);
          // TODO assert on question.length > 1, in practice multiple questions
          // aren't used
          buff.writeUInt16BE(1);
          // answer offset 6
          buff.writeUInt16BE(packet.answer.length & 0xFFFF);
          // authority offset 8
          buff.writeUInt16BE(packet.authority.length & 0xFFFF);
          // additional offset 10
          buff.writeUInt16BE(packet.additional.length & 0xFFFF);
          state = 'QUESTION';
          break;
        case 'TRUNCATE':
          buff.seek(2);
          val = buff.readUInt16BE();
          val |= (1 << 9) & 0x200;
          buff.seek(2);
          buff.writeUInt16BE(val);
          switch (section) {
            case 'answer':
              pos = 6;
              // seek to authority and clear it and additional out
              buff.seek(8);
              buff.writeUInt16BE(0);
              buff.writeUInt16BE(0);
              break;
            case 'authority':
              pos = 8;
              // seek to additional and clear it out
              buff.seek(10);
              buff.writeUInt16BE(0);
              break;
            case 'additional':
              pos = 10;
              break;
          }
          buff.seek(pos);
          buff.writeUInt16BE(count - 1);
          buff.seek(last_resource);
          state = 'END';
          break;
        case 'NAME_PACK':
          name_pack(name, buff, label_index);
          state = next;
          break;
        case 'QUESTION':
          val = packet.question[0];
          assert(val, 'Packet requires a question');
          assertUndefined(val.name, 'Question requires a "name"');
          name = val.name;
          state = 'NAME_PACK';
          next = 'QUESTION_NEXT';
          break;
        case 'QUESTION_NEXT':
          assertUndefined(val.type, 'Question requires a "type"');
          assertUndefined(val.class, 'Questionn requires a "class"');
          buff.writeUInt16BE(val.type & 0xFFFF);
          buff.writeUInt16BE(val.class & 0xFFFF);
          state = 'RESOURCE_RECORD';
          section = 'answer';
          count = 0;
          break;
        case 'RESOURCE_RECORD':
          last_resource = buff.tell();
          if (packet[section].length == count) {
            switch (section) {
              case 'answer':
                section = 'authority';
                state = 'RESOURCE_RECORD';
                break;
              case 'authority':
                section = 'additional';
                state = 'RESOURCE_RECORD';
                break;
              case 'additional':
                state = 'END';
                break;
            }
            count = 0;
          } else {
            state = 'RESOURCE_WRITE';
          }
          break;
        case 'RESOURCE_WRITE':
          val = packet[section][count];
          assertUndefined(val.name, 'Resource record requires "name"');
          name = val.name;
          state = 'NAME_PACK';
          next = 'RESOURCE_WRITE_NEXT';
          break;
        case 'RESOURCE_WRITE_NEXT':
          assertUndefined(val.type, 'Resource record requires "type"');
          assertUndefined(val.class, 'Resource record requires "class"');
          assertUndefined(val.ttl, 'Resource record requires "ttl"');
          buff.writeUInt16BE(val.type & 0xFFFF);
          buff.writeUInt16BE(val.class & 0xFFFF);
          buff.writeUInt32BE(val.ttl & 0xFFFFFFFF);

          // where the rdata length goes
          rdata_pos = buff.tell();
          buff.writeUInt16BE(0);

          state = consts.QTYPE_TO_NAME[val.type];
          break;
        case 'RESOURCE_DONE':
          pos = buff.tell();
          buff.seek(rdata_pos);
          buff.writeUInt16BE(pos - rdata_pos - 2);
          buff.seek(pos);
          count += 1;
          state = 'RESOURCE_RECORD';
          break;
        case 'A':
        case 'AAAA':
          //TODO XXX FIXME -- assert that address is of proper type
          assertUndefined(val.address, 'A/AAAA record requires "address"');
          val = ipaddr.parse(val.address).toByteArray();
          val.forEach(function(b) {
            buff.writeUInt8(b);
          });
          state = 'RESOURCE_DONE';
          break;
        case 'NS':
        case 'CNAME':
        case 'PTR':
          assertUndefined(val.data, 'NS/CNAME/PTR record requires "data"');
          name = val.data;
          state = 'NAME_PACK';
          next = 'RESOURCE_DONE';
          break;
        case 'SPF':
        case 'TXT':
          //TODO XXX FIXME -- split on max char string and loop
          assertUndefined(val.data, 'TXT record requires "data"');
          buff.writeUInt8(val.data.length);
          buff.write(val.data, val.data.length, 'ascii');
          state = 'RESOURCE_DONE';
          break;
        case 'MX':
          assertUndefined(val.priority, 'MX record requires "priority"');
          assertUndefined(val.exchange, 'MX record requires "exchange"');
          buff.writeUInt16BE(val.priority & 0xFFFF);
          name = val.exchange;
          state = 'NAME_PACK';
          next = 'RESOURCE_DONE';
          break;
        case 'SRV':
          assertUndefined(val.priority, 'SRV record requires "priority"');
          assertUndefined(val.weight, 'SRV record requires "weight"');
          assertUndefined(val.port, 'SRV record requires "port"');
          assertUndefined(val.target, 'SRV record requires "target"');
          buff.writeUInt16BE(val.priority & 0xFFFF);
          buff.writeUInt16BE(val.weight & 0xFFFF);
          buff.writeUInt16BE(val.port & 0xFFFF);
          name = val.target;
          state = 'NAME_PACK';
          next = 'RESOURCE_DONE';
          break;
        case 'SOA':
          assertUndefined(val.primary, 'SOA record requires "primary"');
          name = val.primary;
          state = 'NAME_PACK';
          next = 'SOA_ADMIN';
          break;
        case 'SOA_ADMIN':
          assertUndefined(val.admin, 'SOA record requires "admin"');
          name = val.admin;
          state = 'NAME_PACK';
          next = 'SOA_NEXT';
          break;
        case 'SOA_NEXT':
          assertUndefined(val.serial, 'SOA record requires "serial"');
          assertUndefined(val.refresh, 'SOA record requires "refresh"');
          assertUndefined(val.retry, 'SOA record requires "retry"');
          assertUndefined(val.expiration, 'SOA record requires "expiration"');
          assertUndefined(val.minimum, 'SOA record requires "minimum"');
          buff.writeUInt32BE(val.serial & 0xFFFFFFFF);
          buff.writeInt32BE(val.refresh & 0xFFFFFFFF);
          buff.writeInt32BE(val.retry & 0xFFFFFFFF);
          buff.writeInt32BE(val.expiration & 0xFFFFFFFF);
          buff.writeInt32BE(val.minimum & 0xFFFFFFFF);
          state = 'RESOURCE_DONE';
          break;
        case 'OPT':
          while (packet.edns_options.length) {
            val = packet.edns_options.pop();
            buff.writeUInt16BE(val.code);
            buff.writeUInt16BE(val.data.length);
            for (pos = 0; pos < val.data.length; pos++) {
              buff.writeUInt8(val.data.readUInt8(pos));
            }
          }
          state = 'RESOURCE_DONE';
          break;
        case 'NAPTR':
          assertUndefined(val.order, 'NAPTR record requires "order"');
          assertUndefined(val.preference, 'NAPTR record requires "preference"');
          assertUndefined(val.flags, 'NAPTR record requires "flags"');
          assertUndefined(val.service, 'NAPTR record requires "service"');
          assertUndefined(val.regexp, 'NAPTR record requires "regexp"');
          assertUndefined(val.replacement, 'NAPTR record requires "replacement"');
          buff.writeUInt16BE(val.order & 0xFFFF);
          buff.writeUInt16BE(val.preference & 0xFFFF);
          buff.writeUInt8(val.flags.length);
          buff.write(val.flags, val.flags.length, 'ascii');
          buff.writeUInt8(val.service.length);
          buff.write(val.service, val.service.length, 'ascii');
          buff.writeUInt8(val.regexp.length);
          buff.write(val.regexp, val.regexp.length, 'ascii');
          buff.writeUInt8(val.replacement.length);
          buff.write(val.replacement, val.replacement.length, 'ascii');
          state = 'RESOURCE_DONE';
          break;
        case 'END':
          return buff.tell();
          break;
        default:
          throw new Error('WTF No State While Writing');
          break;
      }
    } catch (e) {
      if (e instanceof BufferCursorOverflow) {
        state = 'TRUNCATE';
      } else {
        throw e;
      }
    }
  }
};

function parseHeader(msg, packet, counts) {
  packet.header.id = msg.readUInt16BE();
  var val = msg.readUInt16BE();
  packet.header.qr = (val & 0x8000) >> 15;
  packet.header.opcode = (val & 0x7800) >> 11;
  packet.header.aa = (val & 0x400) >> 10;
  packet.header.tc = (val & 0x200) >> 9;
  packet.header.rd = (val & 0x100) >> 8;
  packet.header.ra = (val & 0x80) >> 7;
  packet.header.res1 = (val & 0x40) >> 6;
  packet.header.res2 = (val & 0x20) >> 5;
  packet.header.res3 = (val & 0x10) >> 4;
  packet.header.rcode = (val & 0xF);
  counts.qdcount = msg.readUInt16BE();
  counts.ancount = msg.readUInt16BE();
  counts.nscount = msg.readUInt16BE();
  counts.arcount = msg.readUInt16BE();
  return 'QUESTION';
}

function parseQuestion(msg, packet) {
  var val = {};
  val.name = nameUnpack(msg);
  val.type = msg.readUInt16BE();
  val.class = msg.readUInt16BE();
  packet.question.push(val);
  // TODO handle qdcount > 0 in practice no one sends this
  return 'RESOURCE_RECORD';
}

function parseRR(msg, val, rdata) {
  val.name = nameUnpack(msg);
  val.type = msg.readUInt16BE();
  val.class = msg.readUInt16BE();
  val.ttl = msg.readUInt32BE();
  rdata.len = msg.readUInt16BE();
  rdata.buf = msg.slice(rdata.len);
  return consts.QTYPE_TO_NAME[val.type];
};

function parseA(val, rdata) {
  var address = '' +
    rdata.buf.readUInt8() +
    '.' + rdata.buf.readUInt8() +
    '.' + rdata.buf.readUInt8() +
    '.' + rdata.buf.readUInt8();
  val.address = address;
  return 'RESOURCE_DONE';
}

function parseAAAA(val, rdata) {
  var address = '';
  var compressed = false;

  for (var i = 0; i < 8; i++) {
    if (i > 0) address += ':';
    // TODO zero compression
    address += rdata.buf.readUInt16BE().toString(16);
  }
  val.address = address;
  return 'RESOURCE_DONE';
}

function parseCname(val, msg, rdata) {
  var pos = msg.tell();
  msg.seek(pos - rdata.len);
  val.data = nameUnpack(msg);
  msg.seek(pos);
  return 'RESOURCE_DONE';
}

function parseTxt(val, rdata) {
  val.data = '';
  while (!rdata.buf.eof()) {
    val.data += rdata.buf.toString('ascii', rdata.buf.readUInt8());
  }
  return 'RESOURCE_DONE';
}

function parseMx(val, msg, rdata) {
  val.priority = rdata.buf.readUInt16BE();
  var pos = msg.tell();
  msg.seek(pos - rdata.len + rdata.buf.tell());
  val.exchange = nameUnpack(msg);
  msg.seek(pos);
  return 'RESOURCE_DONE';
}

function parseSrv(val, msg, rdata) {
  val.priority = rdata.buf.readUInt16BE();
  val.weight = rdata.buf.readUInt16BE();
  val.port = rdata.buf.readUInt16BE();
  var pos = msg.tell();
  msg.seek(pos - rdata.len + rdata.buf.tell());
  val.target = nameUnpack(msg);
  msg.seek(pos);
  return 'RESOURCE_DONE';
}

function parseSoa(val, msg, rdata) {
  var pos = msg.tell();
  msg.seek(pos - rdata.len + rdata.buf.tell());
  val.primary = nameUnpack(msg);
  val.admin = nameUnpack(msg);
  rdata.buf.seek(msg.tell() - (pos - rdata.len + rdata.buf.tell()));
  msg.seek(pos);
  val.serial = rdata.buf.readUInt32BE();
  val.refresh = rdata.buf.readInt32BE();
  val.retry = rdata.buf.readInt32BE();
  val.expiration = rdata.buf.readInt32BE();
  val.minimum = rdata.buf.readInt32BE();
  return 'RESOURCE_DONE';
}

function parseNaptr(val, rdata) {
  val.order = rdata.buf.readUInt16BE();
  val.preference = rdata.buf.readUInt16BE();
  var pos = rdata.buf.readUInt8();
  val.flags = rdata.buf.toString('ascii', pos);
  pos = rdata.buf.readUInt8();
  val.service = rdata.buf.toString('ascii', pos);
  pos = rdata.buf.readUInt8();
  val.regexp = rdata.buf.toString('ascii', pos);
  pos = rdata.buf.readUInt8();
  val.replacement = rdata.buf.toString('ascii', pos);
  return 'RESOURCE_DONE';
}

Packet.parse = function(msg) {
  var state,
      pos,
      val,
      rdata,
      counts = {},
      section,
      count;

  var packet = new Packet();

  pos = 0;
  state = 'HEADER';

  msg = BufferCursor(msg);

  while (true) {
    switch (state) {
      case 'HEADER':
        state = parseHeader(msg, packet, counts);
        break;
      case 'QUESTION':
        state = parseQuestion(msg, packet);
        section = 'answer';
        count = 'ancount';
        break;
      case 'RESOURCE_RECORD':
        if (counts[count] === packet[section].length) {
          switch (section) {
            case 'answer':
              section = 'authority';
              count = 'nscount';
              break;
            case 'authority':
              section = 'additional';
              count = 'arcount';
              break;
            case 'additional':
              state = 'END';
              break;
          }
        } else {
          state = 'RR_UNPACK';
        }
        break;
      case 'RR_UNPACK':
        val = {};
        rdata = {};
        state = parseRR(msg, val, rdata);
        break;
      case 'RESOURCE_DONE':
        packet[section].push(val);
        state = 'RESOURCE_RECORD';
        break;
      case 'A':
        state = parseA(val, rdata);
        break;
      case 'AAAA':
        state = parseAAAA(val, rdata);
        break;
      case 'NS':
      case 'CNAME':
      case 'PTR':
        state = parseCname(val, msg, rdata);
        break;
      case 'SPF':
      case 'TXT':
        state = parseTxt(val, rdata);
        break;
      case 'MX':
        state = parseMx(val, msg, rdata);
        break;
      case 'SRV':
        state = parseSrv(val, msg, rdata);
        break;
      case 'SOA':
        state = parseSoa(val, msg, rdata);
        break;
      case 'OPT':
        // assert first entry in additional
        counts[count] -= 1;
        packet.payload = val.class;
        pos = msg.tell();
        msg.seek(pos - 6);
        packet.header.rcode = (msg.readUInt8() << 4) + packet.header.rcode;
        packet.edns_version = msg.readUInt8();
        val = msg.readUInt16BE();
        msg.seek(pos);
        packet.do = (val & 0x8000) << 15;
        while (!rdata.buf.eof()) {
          packet.edns_options.push({
            code: rdata.buf.readUInt16BE(),
            data: rdata.buf.slice(rdata.buf.readUInt16BE()).buffer
          });
        }
        state = 'RESOURCE_RECORD';
        break;
      case 'NAPTR':
        state = parseNaptr(val, rdata);
        break;
      case 'END':
        return packet;
        break;
      default:
        //console.log(state, val);
        state = 'RESOURCE_DONE';
        break;
    }
  }
};