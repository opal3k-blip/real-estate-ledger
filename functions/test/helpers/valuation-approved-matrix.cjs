'use strict';
/* The permission matrix as DECIDED by Opal on 2026-10-08 15:36 (R1-B1), written out by hand.
   It is deliberately NOT derived from ROLE_LISTS: the tests compare the implementation against this literal, so any
   widening (or narrowing) of the implementation fails until this decision record is changed on purpose. */
const ROLES = ['analyst', 'senior_ic', 'fund_manager', 'admin'];
const APPROVED = {
  createDraft:  { analyst: false, senior_ic: false, fund_manager: true,  admin: true },
  updateDraft:  { analyst: false, senior_ic: false, fund_manager: true,  admin: true },
  submit:       { analyst: false, senior_ic: false, fund_manager: true,  admin: true },
  withdraw:     { analyst: false, senior_ic: false, fund_manager: true,  admin: true },
  review:       { analyst: false, senior_ic: true,  fund_manager: false, admin: true },
  returnDraft:  { analyst: false, senior_ic: true,  fund_manager: false, admin: true },
  reject:       { analyst: false, senior_ic: true,  fund_manager: false, admin: true },
  approve:      { analyst: false, senior_ic: true,  fund_manager: false, admin: true },
  suspend:      { analyst: false, senior_ic: true,  fund_manager: false, admin: true },
  reinstate:    { analyst: false, senior_ic: true,  fund_manager: false, admin: true },
  preview:      { analyst: false, senior_ic: true,  fund_manager: true,  admin: true },   // = the client read audience
};
module.exports = { ROLES, APPROVED };
