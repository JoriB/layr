import {Entity, FieldMask} from '@liaison/model';
import {hasOwnProperty, getInheritedPropertyDescriptor} from '@liaison/util';
import difference from 'lodash/difference';
import uniq from 'lodash/uniq';
import ow from 'ow';

import {StorableField} from './storable-field';
import {Cache} from './cache';

const DEFAULT_CACHE_SIZE = 1000;

export const Storable = (Base = Entity, {storeName} = {}) => {
  let Storable;

  if (!isStorable(Base.prototype)) {
    Storable = extendClass(Base);
  } else {
    Storable = class Storable extends Base {};
  }

  Storable.__storeName = storeName;

  return Storable;
};

function extendClass(Base) {
  const Storable = class Storable extends Base {
    static $Field = StorableField;

    static async $open() {
      this.__cache = new Cache(this, {size: DEFAULT_CACHE_SIZE});
    }

    static async $get(keys, {fields, reload, populate = true, throwIfNotFound = true} = {}) {
      if (!Array.isArray(keys)) {
        return (await this.$get([keys], {fields, reload, populate, throwIfNotFound}))[0];
      }

      const {name, values} = this.__extractKeys(keys);

      let storables;
      if (name === 'id') {
        storables = values.map(value => this.$deserialize({_id: value}));
      } else {
        storables = await this.$getId(name, values, {reload, throwIfNotFound});
      }

      await this.$load(storables, {fields, reload, populate, throwIfNotFound});

      return storables;
    }

    static async $getId(name, values, {reload, throwIfNotFound}) {
      const {storables = [], missingValues = values} = !reload ?
        this.__cache.find(name, values) :
        {};

      if (missingValues.length === 0) {
        return storables;
      }

      let missingStorables;

      if (this.$hasStore()) {
        missingStorables = await this._getIdFromStore(name, missingValues, {throwIfNotFound});
      } else {
        missingStorables = await super.$getId(name, missingValues, {reload, throwIfNotFound});
      }

      this.__cache.save(missingStorables);

      return [...storables, ...missingStorables];
    }

    static async _getIdFromStore(name, values, {throwIfNotFound}) {
      const store = this.$getStore();
      const serializedStorables = await store.find(
        {_type: this.$getRegisteredName(), [name]: values},
        {fields: {[name]: true}}
      );

      const foundValues = serializedStorables.map(serializedStorable => serializedStorable[name]);

      const uniqueValues = uniq(foundValues);
      if (uniqueValues.length < foundValues.length) {
        throw new Error(`Found duplicated values in a unique field (name: '${name}')`);
      }

      if (foundValues.length < values.length && throwIfNotFound) {
        const missingValues = difference(values, foundValues);
        throw new Error(`Item(s) not found (${name}(s): ${JSON.stringify(missingValues)})`);
      }

      const storables = serializedStorables.map(serializedStorable =>
        this.$deserialize(serializedStorable)
      );

      return storables;
    }

    static __extractKeys(keys) {
      let name;
      const values = new Set();

      for (const key of keys) {
        ow(key, ow.object);

        const keyNames = Object.keys(key);
        if (keyNames.length !== 1) {
          throw new Error(
            `A key must be an object composed of one unique field (key: ${JSON.stringify(key)})`
          );
        }

        const keyName = keyNames[0];

        if (name === undefined) {
          const isUnique = keyName === 'id' || this.prototype.$getField(keyName).isUnique();
          if (!isUnique) {
            throw new Error(`A key name must correspond to a unique field (name: '${keyName}')`);
          }
          name = keyName;
        } else if (name !== keyName) {
          throw new Error(
            `Cannot handle different key names in a set of keys (keys: ${JSON.stringify(keys)})`
          );
        }

        const keyValue = key[keyName];

        if (keyValue === undefined) {
          throw new Error(`A key value cannot be undefined (name: '${name}')`);
        }

        if (values.has(keyValue)) {
          throw new Error(`A key value cannot be duplicated (name: '${name}')`);
        }

        values.add(keyValue);
      }

      return {name, values: Array.from(values)};
    }

    static async $has(keys, {reload} = {}) {
      if (!Array.isArray(keys)) {
        return await this.$has([keys], {reload});
      }

      const storables = await this.$get(keys, {fields: false, reload, throwIfNotFound: false});

      return storables.length === keys.length;
    }

    static async $load(storables, {fields, reload, populate = true, throwIfNotFound = true} = {}) {
      if (!Array.isArray(storables)) {
        return (await this.$load([storables], {fields, reload, populate, throwIfNotFound}))[0];
      }

      fields = this.prototype.$createFieldMask(fields);

      if (!reload) {
        const {missingStorables, missingFields} = this.__cache.load(storables, {fields});

        if (missingStorables.length === 0) {
          return;
        }

        storables = missingStorables;
        fields = missingFields;
      }

      if (this.$hasStore()) {
        await this.__loadFromStore(storables, {fields, throwIfNotFound});
      } else {
        await super.$load(storables, {fields, reload, populate: false, throwIfNotFound});
      }

      for (const storable of storables) {
        await storable.$afterLoad({fields});
      }

      this.__cache.save(storables);

      if (populate) {
        // TODO:
        // await this.$populate(storables, {fields, throwIfNotFound});
      }

      return storables;
    }

    static async $reload(storables, {fields, populate = true, throwIfNotFound = true} = {}) {
      await this.$load(storables, {fields, reload: true, populate, throwIfNotFound});
    }

    static async __loadFromStore(storables, {fields, throwIfNotFound}) {
      fields = this.prototype.$createFieldMaskForStorableFields(fields);

      let serializedStorables = storables.map(storable => storable.$serializeReference());

      const store = this.$getStore();
      const serializedFields = fields.serialize();
      serializedStorables = await store.load(serializedStorables, {
        fields: serializedFields,
        throwIfNotFound
      });

      for (const serializedStorable of serializedStorables) {
        this.$deserialize(serializedStorable);
      }
    }

    async $load({fields, reload, populate = true, throwIfNotFound = true} = {}) {
      await this.constructor.$load([this], {fields, reload, populate, throwIfNotFound});
    }

    async $reload({fields, populate = true, throwIfNotFound = true} = {}) {
      await this.$load({fields, reload: true, populate, throwIfNotFound});
    }

    static async $populate(storables, {fields, throwIfNotFound = true} = {}) {
      if (!Array.isArray(storables)) {
        return (await this.$populate([storables], {fields, throwIfNotFound}))[0];
      }

      fields = new FieldMask(fields);

      let didLoad;
      do {
        didLoad = await this.__populate(storables, {fields, throwIfNotFound});
      } while (didLoad);
    }

    static async __populate(storables, {fields, throwIfNotFound}) {
      const storablesByClass = new Map();

      for (const storable of storables) {
        if (!storable) {
          continue;
        }

        storable.forEachNestedEntityDeep(
          (storable, {fields}) => {
            if (storable.fieldsAreActive(fields)) {
              return;
            }

            const klass = storable.constructor;
            let entry = storablesByClass.get(klass);
            if (!entry) {
              entry = {storables: [], fields: undefined};
              storablesByClass.set(klass, entry);
            }
            if (!entry.storables.includes(storable)) {
              entry.storables.push(storable);
            }
            entry.fields = FieldMask.add(entry.fields, fields);
          },
          {fields}
        );
      }

      if (!storablesByClass.size) {
        return false;
      }

      for (const [klass, {storables, fields}] of storablesByClass.entries()) {
        await klass.$load(storables, {fields, populate: false, throwIfNotFound});
      }

      return true;
    }

    async $populate({fields, throwIfNotFound = true} = {}) {
      return (await this.constructor.$populate([this], {fields, throwIfNotFound}))[0];
    }

    static async $save(storables, {throwIfNotFound = true, throwIfAlreadyExists = true} = {}) {
      if (!Array.isArray(storables)) {
        return (await this.$save([storables], {throwIfNotFound, throwIfAlreadyExists}))[0];
      }

      for (const storable of storables) {
        await storable.$beforeSave();
      }

      if (this.$hasStore()) {
        await this.__saveToStore(storables, {throwIfNotFound, throwIfAlreadyExists});
      } else {
        await super.$save(storables, {throwIfNotFound, throwIfAlreadyExists});
      }

      for (const storable of storables) {
        await storable.$afterSave();
      }

      this.__cache.save(storables);

      return storables;
    }

    static async __saveToStore(storables, {throwIfNotFound, throwIfAlreadyExists}) {
      const fields = this.prototype.$createFieldMaskForStorableFields();

      for (const storable of storables) {
        storable.$validate({fields});
      }

      let serializedStorables = storables.map(storable => storable.$serialize({fields}));

      const store = this.$getStore();
      serializedStorables = await store.save(serializedStorables, {
        throwIfNotFound,
        throwIfAlreadyExists
      });

      for (const serializedStorable of serializedStorables) {
        this.$deserialize(serializedStorable);
      }
    }

    async $save({throwIfNotFound = true, throwIfAlreadyExists = true} = {}) {
      await this.constructor.$save([this], {throwIfNotFound, throwIfAlreadyExists});
    }

    static async $delete(storables, {throwIfNotFound = true} = {}) {
      if (!Array.isArray(storables)) {
        return (await this.$delete([storables], {throwIfNotFound}))[0];
      }

      for (const storable of storables) {
        await storable.$beforeDelete();
      }

      if (this.$hasStore()) {
        await this.__deleteFromStore(storables, {throwIfNotFound});
      } else {
        await super.$delete(storables, {throwIfNotFound});
      }

      for (const storable of storables) {
        await storable.$afterDelete();
      }

      this.__cache.delete(storables);

      return storables;
    }

    static async __deleteFromStore(storables, {throwIfNotFound}) {
      const serializedStorables = storables.map(storable => storable.$serializeReference());

      const store = this.$getStore();
      await store.delete(serializedStorables, {throwIfNotFound});
    }

    async $delete({throwIfNotFound = true} = {}) {
      await this.constructor.$delete([this], {throwIfNotFound});
    }

    static async $find({
      filter,
      sort,
      skip,
      limit,
      load = true,
      fields,
      reload,
      populate,
      throwIfNotFound
    } = {}) {
      fields = this.prototype.$createFieldMask(fields);

      let storables;

      if (this.$hasStore()) {
        storables = await this.__findInStore({filter, sort, skip, limit, fields: {}}); // TODO: Remove 'fields' option
      } else {
        storables = await super.$find({filter, sort, skip, limit, load: false});
      }

      if (load) {
        await this.$load(storables, {fields, reload, populate, throwIfNotFound});
      }

      return storables;
    }

    static async __findInStore({filter, sort, skip, limit, fields}) {
      fields = this.prototype.$createFieldMaskForStorableFields(fields);

      const store = this.$getStore();
      const serializedFields = fields.serialize();
      const serializedStorables = await store.find(
        {_type: this.$getRegisteredName(), ...filter},
        {sort, skip, limit, fields: serializedFields}
      );

      const storables = serializedStorables.map(serializedStorable =>
        this.$deserialize(serializedStorable)
      );

      return storables;
    }

    static $getStore() {
      return this.$getLayer().get(this.__storeName);
    }

    static $hasStore() {
      return this.__storeName !== undefined;
    }

    // === Hooks ===

    async $afterLoad() {
      for (const substorable of this.$getSubstorables()) {
        await substorable.$afterLoad();
      }
    }

    async $beforeSave() {
      for (const substorable of this.$getSubstorables()) {
        await substorable.$beforeSave();
      }
    }

    async $afterSave() {
      for (const substorable of this.$getSubstorables()) {
        await substorable.$afterSave();
      }
    }

    async $beforeDelete() {
      for (const substorable of this.$getSubstorables()) {
        await substorable.$beforeDelete();
      }
    }

    async $afterDelete() {
      for (const substorable of this.$getSubstorables()) {
        await substorable.$afterDelete();
      }
    }

    $getSubstorables() {
      const filter = function (field) {
        return typeof field.getScalar().getModel()?.isSubstorable === 'function';
      };
      return this.$getFieldValues({filter});
    }

    // === Storable fields ===

    $addStorableField(name) {
      if (!this.__storableFields) {
        this.__storableFields = new Map();
      } else if (!hasOwnProperty(this, '__storableFields')) {
        this.__storableFields = new Map(this.__storableFields);
      }
      this.__storableFields.set(name, {name});
    }

    $createFieldMaskForStorableFields(fields = true) {
      return this.$createFieldMask(fields, {
        filter(field) {
          return field.getParent().__storableFields?.has(field.getName());
        }
      });
    }

    // === Unique fields ===

    $getUniqueFields() {
      return this.$getFields({filter: field => field.isUnique()});
    }

    // === Utilities ===

    static isStorable(object) {
      return isStorable(object);
    }
  };

  return Storable;
}

// === Decorators ===

export function store() {
  return function (target, name, descriptor) {
    if (!isStorable(target)) {
      throw new Error(`@store() target must be a storable`);
    }
    if (!(name && descriptor)) {
      throw new Error(`@store() must be used to decorate properties`);
    }

    if (descriptor.initializer !== undefined) {
      // @store() is used on an property defined in a parent class
      // Example: `@store() title;`
      descriptor = getInheritedPropertyDescriptor(target, name);
      if (descriptor === undefined) {
        throw new Error(`Cannot use @store() with an undefined property (name: '${name}')`);
      }
    }

    target.$addStorableField(name);

    return descriptor;
  };
}

// === Utilities ===

export function isStorable(object) {
  return typeof object?.constructor?.isStorable === 'function';
}
