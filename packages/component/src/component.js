import {possiblyAsync} from 'possibly-async';
import lowerFirst from 'lodash/lowerFirst';
import ow from 'ow';

import {WithProperties} from './with-properties';
import {serialize} from './serialization';
import {deserialize} from './deserialization';
import {AttributeSelector} from './attribute-selector';
import {
  isComponentClass,
  isComponent,
  validateIsComponentClassOrInstance,
  validateComponentName
} from './utilities';

export const Component = (Base = Object) => {
  ow(Base, ow.function);

  if (isComponentClass(Base)) {
    return Base;
  }

  class Component extends WithProperties(Base) {
    static getComponentType() {
      return 'Component';
    }

    getComponentType() {
      return 'component';
    }

    // === Creation ===

    constructor(object = {}, options) {
      ow(object, 'object', ow.object);

      super(object, options);

      this.markAsNew();
    }

    static __instantiate(attributes = {}, options = {}) {
      ow(attributes, 'attributes', ow.object);
      ow(options, 'options', ow.object.exactShape({isNew: ow.optional.boolean}));

      const {isNew = false} = options;

      if (isNew === true) {
        let attributeSelector = this.prototype.expandAttributeSelector(true, {depth: 0});
        const deserializedAttributeSelector = AttributeSelector.fromNames(Object.keys(attributes));
        attributeSelector = AttributeSelector.remove(
          attributeSelector,
          deserializedAttributeSelector
        );

        return new this({}, {attributeSelector});
      }

      return Object.create(this.prototype);
    }

    // === Naming ===

    static getComponentName(options = {}) {
      ow(options, 'options', ow.object.exactShape({throwIfMissing: ow.optional.boolean}));

      const {throwIfMissing = true} = options;

      const name = this.__name ?? this.name;

      if (typeof name === 'string' && name !== '') {
        return name;
      }

      if (throwIfMissing) {
        throw new Error("Component's name is missing");
      }
    }

    getComponentName(options = {}) {
      ow(options, 'options', ow.object.exactShape({throwIfMissing: ow.optional.boolean}));

      return lowerFirst(this.constructor.getComponentName(options));
    }

    static setComponentName(name) {
      ow(name, 'name', ow.string);

      validateComponentName(name, {allowInstances: false});

      Object.defineProperty(this, '__name', {value: name, configurable: true});
    }

    // === isNew mark ===

    isNew() {
      return this.__isNew === true;
    }

    markAsNew() {
      Object.defineProperty(this, '__isNew', {value: true, configurable: true});
    }

    markAsNotNew() {
      Object.defineProperty(this, '__isNew', {value: false, configurable: true});
    }

    // === Forking ===

    static fork() {
      return class extends this {};
    }

    fork(Component) {
      // TODO: Altering the constructor sounds wrong
      ow(Component, 'Component', ow.optional.function);

      const forkedComponent = Object.create(this);

      if (Component !== undefined) {
        Object.defineProperty(forkedComponent, 'constructor', {
          value: Component,
          writable: true,
          enumerable: false,
          configurable: true
        });
      }

      return forkedComponent;
    }

    // === Utilities ===

    static isComponent(object) {
      return isComponent(object);
    }
  }

  const classAndInstanceMethods = {
    // === Related components ===

    // TODO: Handle forking

    getRelatedComponent(name, options = {}) {
      ow(name, 'name', ow.string.nonEmpty);
      ow(options, 'options', ow.object.exactShape({throwIfMissing: ow.optional.boolean}));

      const {throwIfMissing = true} = options;

      validateComponentName(name);

      const relatedComponents = this.__getRelatedComponents();
      const relatedComponent = relatedComponents[name];

      if (relatedComponent !== undefined) {
        return relatedComponent;
      }

      if (throwIfMissing) {
        throw new Error(`Cannot get the related component '${name}'`);
      }
    },

    registerRelatedComponent(component) {
      validateIsComponentClassOrInstance(component);

      const relatedComponents = this.__getRelatedComponents();
      const componentName = component.getComponentName();
      relatedComponents[componentName] = component;
    },

    __getRelatedComponents() {
      if (this.__relatedComponents === undefined) {
        Object.defineProperty(this, '__relatedComponents', {
          value: Object.create(null),
          configurable: true
        });
      }

      return this.__relatedComponents;
    },

    // === Serialization ===

    serialize(options = {}) {
      ow(options, 'options', ow.object);

      const serializedComponent = {__component: this.getComponentName()};

      if (isComponent(this) && this.isNew()) {
        serializedComponent.__new = true;
      }

      return possiblyAsync(this.__serializeAttributes(serializedComponent, options), {
        then: () => serializedComponent
      });
    },

    __serializeAttributes(serializedComponent, options) {
      ow(serializedComponent, 'serializedComponent', ow.object);
      ow(options, 'options', ow.object.partialShape({attributeFilter: ow.optional.function}));

      const {attributeFilter} = options;

      return possiblyAsync.forEach(this.getAttributes({setAttributesOnly: true}), attribute => {
        return possiblyAsync(
          attributeFilter !== undefined ? attributeFilter.call(this, attribute) : true,
          {
            then: isNotFilteredOut => {
              if (isNotFilteredOut) {
                const attributeName = attribute.getName();
                const attributeValue = attribute.getValue();
                return possiblyAsync(serialize(attributeValue, options), {
                  then: serializedAttributeValue => {
                    serializedComponent[attributeName] = serializedAttributeValue;
                  }
                });
              }
            }
          }
        );
      });
    },

    // === Deserialization ===

    deserialize(object = {}, options = {}) {
      ow(object, 'object', ow.object);
      ow(options, 'options', ow.object);

      const expectedComponentName = this.getComponentName();

      const {__component: componentName = expectedComponentName, __new, ...attributes} = object;

      validateComponentName(componentName);

      if (componentName !== expectedComponentName) {
        throw new Error(
          `An unexpected component name was encountered while deserializing an object (encountered name: '${componentName}', expected name: '${expectedComponentName}')`
        );
      }

      const deserializedComponent = isComponentClass(this)
        ? this
        : this.constructor.__instantiate(attributes, {isNew: __new});

      return possiblyAsync(deserializedComponent.__deserializeAttributes(attributes, options), {
        then: () => deserializedComponent
      });
    },

    __deserializeAttributes(attributes, options) {
      ow(attributes, 'attributes', ow.object);
      ow(options, 'options', ow.object.partialShape({attributeFilter: ow.optional.function}));

      const {attributeFilter} = options;

      const componentGetter = name => this.getRelatedComponent(name);

      return possiblyAsync.forEach(
        Object.entries(attributes),
        ([attributeName, attributeValue]) => {
          const attribute = this.getAttribute(attributeName, {
            throwIfMissing: false
          });

          if (attribute === undefined) {
            return;
          }

          return possiblyAsync(
            attributeFilter !== undefined ? attributeFilter.call(this, attribute) : true,
            {
              then: isNotFilteredOut => {
                if (isNotFilteredOut) {
                  return possiblyAsync(deserialize(attributeValue, {...options, componentGetter}), {
                    then: deserializedAttributeValue => {
                      attribute.setValue(deserializedAttributeValue);
                    }
                  });
                }
              }
            }
          );
        }
      );
    },

    // === Introspection ===

    introspect() {
      const introspectedProperties = this.introspectProperties();

      if (introspectedProperties.length === 0) {
        return undefined;
      }

      const introspectedComponent = {
        name: this.getComponentName(),
        type: this.getComponentType(),
        properties: introspectedProperties
      };

      return introspectedComponent;
    }
  };

  Object.assign(Component, classAndInstanceMethods);
  Object.assign(Component.prototype, classAndInstanceMethods);

  return Component;
};
